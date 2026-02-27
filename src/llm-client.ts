import { generateText } from "ai";
import { getModel } from "./providers.js";
import { loadPrompt } from "./prompt-loader.js";
import { LLMChunkOutputSchema, ChatResponseSchema } from "./schemas.js";
import { ZodError } from "zod";
import type { ChatResponse, LLMChunkOutput } from "./schemas.js";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { CONFIG } from "./config.js";
import { logger } from "./logger.js";
import { parseGuideEntries } from "./guide-parser.js";

// ─── Lazy-initialised model ────────────────────────────────────────────────────

let _model: ReturnType<typeof getModel> | null = null;
function model() {
  if (!_model) _model = getModel();
  return _model;
}

// ─── Circuit Breaker ───────────────────────────────────────────────────────────
//
// CLOSED  — normal operation
// OPEN    — threshold failures hit; calls fail-fast
// HALF_OPEN — one probe after resetMs; success → CLOSED, fail → OPEN

type BreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

const breaker = { state: "CLOSED" as BreakerState, failures: 0, openedAt: 0 };

export function getBreakerState(): BreakerState {
  return breaker.state;
}

function breakerCall<T>(fn: () => Promise<T>): Promise<T> {
  const { circuitBreakerThreshold, circuitBreakerResetMs } = CONFIG.server;
  const now = Date.now();

  if (breaker.state === "OPEN") {
    if (now - breaker.openedAt >= circuitBreakerResetMs) {
      breaker.state = "HALF_OPEN";
      logger.warn("Circuit breaker: HALF_OPEN — sending probe request");
    } else {
      const remaining = Math.ceil(
        (circuitBreakerResetMs - (now - breaker.openedAt)) / 1000,
      );
      return Promise.reject(
        new Error(`Circuit breaker OPEN — retrying in ${remaining}s.`),
      );
    }
  }

  return fn().then(
    (result) => {
      if (breaker.state !== "CLOSED")
        logger.info("Circuit breaker: probe succeeded — CLOSED");
      breaker.failures = 0;
      breaker.state = "CLOSED";
      return result;
    },
    (err) => {
      breaker.failures++;
      if (
        breaker.state === "HALF_OPEN" ||
        breaker.failures >= circuitBreakerThreshold
      ) {
        breaker.state = "OPEN";
        breaker.openedAt = Date.now();
        logger.error(
          `Circuit breaker: OPEN after ${breaker.failures} failure(s). Retry in ${circuitBreakerResetMs / 1000}s.`,
        );
      }
      throw err;
    },
  );
}

/** Run fn() through the circuit breaker with one retry on transient errors. */
export async function callLlmWithRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await breakerCall(fn);
  } catch {
    await new Promise((r) => setTimeout(r, 2_000));
    return breakerCall(fn);
  }
}

// ─── Guide loader ──────────────────────────────────────────────────────────────

let _guideCache: string | null = null;

export async function loadGuide(): Promise<string> {
  if (_guideCache) return _guideCache;
  _guideCache = await readFile(CONFIG.paths.guide, "utf-8");
  return _guideCache;
}

export function clearGuideCache(): void {
  _guideCache = null;
}

// ─── Chunk loader ──────────────────────────────────────────────────────────────

async function loadChunk(filePath: string): Promise<string> {
  return readFile(join(process.cwd(), filePath), "utf-8");
}

// ─── JSON cleaner ──────────────────────────────────────────────────────────────

export function cleanJson(raw: string): string {
  let cleaned = raw
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  const firstBracket = cleaned.search(/[\[{]/);
  if (firstBracket === -1) return cleaned;
  cleaned = cleaned.slice(firstBracket);

  const openChar = cleaned[0];
  const closeChar = openChar === "[" ? "]" : "}";
  let depth = 0,
    endIndex = -1,
    inString = false,
    escapeNext = false;

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escapeNext = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === openChar) depth++;
    else if (ch === closeChar && --depth === 0) {
      endIndex = i;
      break;
    }
  }

  if (endIndex !== -1) cleaned = cleaned.slice(0, endIndex + 1).trim();
  return cleaned.replace(/,\s*}/g, "}").replace(/,\s*]/g, "]");
}

// ─── LLM Error Classification ─────────────────────────────────────────────────

export type LlmErrorType =
  | "rate_limit"
  | "auth"
  | "token_limit"
  | "transient"
  | "unknown";

export function classifyLlmError(err: unknown): LlmErrorType {
  const msg =
    err instanceof Error
      ? err.message.toLowerCase()
      : String(err).toLowerCase();
  const status: number | undefined =
    (err as any)?.status ?? (err as any)?.statusCode;

  if (
    status === 401 ||
    status === 403 ||
    msg.includes("api key") ||
    msg.includes("unauthorized") ||
    msg.includes("forbidden")
  )
    return "auth";
  if (
    status === 429 ||
    msg.includes("rate limit") ||
    msg.includes("too many requests") ||
    msg.includes("quota")
  )
    return "rate_limit";
  if (
    msg.includes("token") ||
    msg.includes("context length") ||
    msg.includes("maximum context") ||
    msg.includes("content too large") ||
    status === 413
  )
    return "token_limit";
  if (status !== undefined && status >= 500) return "transient";
  return "unknown";
}

/** Exponential backoff with optional jitter. */
function sleep(attempt: number): Promise<void> {
  const base = CONFIG.extraction.retryBaseDelayMs;
  const cap = CONFIG.extraction.retryMaxDelayMs;
  let ms = Math.min(base * Math.pow(2, attempt), cap);
  if (CONFIG.extraction.retryJitter) {
    ms = Math.round(ms * (1 + (Math.random() * 0.4 - 0.2)));
  }
  logger.warn(`Backoff: waiting ${ms}ms before retry (attempt ${attempt + 1})`);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Chunk Extraction ──────────────────────────────────────────────────────────

export async function extractChunksFromDocument(
  pdfBase64: string,
  overridePrompt?: string,
  extractionType: "procedure" | "qna" | "chat" = "procedure",
): Promise<LLMChunkOutput[]> {
  const isPdfEmpty = !pdfBase64 || pdfBase64.trim().length === 0;
  if (isPdfEmpty && !overridePrompt) {
    logger.error("extractChunksFromDocument received empty content — aborting");
    return [];
  }

  logger.info(`Sending request to LLM for ${extractionType} extraction`);

  const systemPrompt = await loadPrompt(
    extractionType === "qna"
      ? "qna-extraction"
      : extractionType === "chat"
        ? "chat-extraction"
        : "extraction",
  );

  const userMessage =
    overridePrompt ??
    `Read every page of this PDF carefully and thoroughly.

Your task:
1. Identify ALL distinct processes, procedures, troubleshooting flows, and how-to guides.
2. Extract EVERY image, screenshot, diagram, and visual element with exhaustive descriptions.
3. Produce one chunk object per distinct concept — do not merge, do not skip.

Required fields for every chunk: chunk_id, topic, summary, triggers, has_conditions, related_chunks, status, context, response.
Optional fields (include ONLY when applicable): conditions (only if has_conditions is true), constraints (only if hard system limits exist).

Return ONLY a raw JSON array. Start with [ and end with ]. No markdown fences. No explanation.`;

  const contentArray: any[] = [{ type: "text" as const, text: userMessage }];
  if (!isPdfEmpty) {
    contentArray.push({
      type: "file" as const,
      data: pdfBase64,
      mediaType: "application/pdf",
    });
  }

  const messages = [{ role: "user" as const, content: contentArray }];
  const maxRetries = CONFIG.extraction.llmRetries ?? 2;
  let lastError: unknown;
  let text: string;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0)
      logger.warn(
        `Retrying extraction (attempt ${attempt + 1}/${maxRetries + 1})`,
      );

    try {
      const result = await breakerCall(() =>
        generateText({
          model: model(),
          system: systemPrompt,
          messages,
          maxOutputTokens: CONFIG.extraction.maxOutputTokens,
        }),
      );
      text = result.text;
    } catch (error) {
      lastError = error;
      const errType = classifyLlmError(error);
      logger.error(
        `LLM call failed [${errType}] during extraction (attempt ${attempt + 1})`,
        {
          error: error instanceof Error ? error.message : String(error),
        },
      );
      if (errType === "auth" || errType === "token_limit") break;
      if (attempt < maxRetries) await sleep(attempt);
      continue;
    }

    const cleaned = cleanJson(text!);
    let parsed: any;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      lastError = parseErr;
      try {
        const reportsDir = CONFIG.paths.reports;
        await mkdir(reportsDir, { recursive: true });
        const debugFile = join(reportsDir, `llm-raw-debug-${Date.now()}.txt`);
        await writeFile(debugFile, text!, "utf-8");
        logger.error(
          `Invalid JSON from LLM (attempt ${attempt + 1}). Raw saved to: ${debugFile}`,
          {
            parseError:
              parseErr instanceof Error ? parseErr.message : String(parseErr),
            preview: cleaned.substring(0, 500),
          },
        );
      } catch {
        logger.error("Invalid JSON from LLM", {
          preview: cleaned.substring(0, 500),
        });
      }
      continue;
    }

    const arr: any[] = Array.isArray(parsed) ? parsed : [parsed];
    logger.debug(`Parsed ${arr.length} chunk(s) from LLM output`, {
      chunks: arr.map((item, i) => ({
        index: i,
        chunk_id: item?.chunk_id ?? "MISSING",
        topic: item?.topic ?? "MISSING",
        triggers: item?.triggers?.length ?? 0,
        hasContext: !!item?.context,
        hasResponse: !!item?.response,
      })),
    });

    const validated: LLMChunkOutput[] = [];
    for (const item of arr) {
      if (item?.has_conditions === true && !item?.conditions) {
        logger.warn(
          `Chunk "${item?.chunk_id}" has has_conditions:true but no conditions — flagging review`,
        );
        item.status = "review";
      }
      try {
        validated.push(LLMChunkOutputSchema.parse(item));
      } catch (err) {
        if (err instanceof ZodError) {
          logger.error(
            `Validation failed for "${item?.chunk_id ?? "unknown"}"`,
            {
              issues: err.issues.map(
                (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
              ),
            },
          );
        } else {
          logger.error(
            `Unexpected error for "${item?.chunk_id ?? "unknown"}"`,
            { err },
          );
        }
      }
    }

    logger.info(`${validated.length} chunk(s) validated from LLM extraction`);
    return validated;
  }

  logger.error(
    `All ${maxRetries + 1} extraction attempt(s) failed. Returning empty array.`,
  );
  return [];
}

// ─── Step 1: Retrieval ─────────────────────────────────────────────────────────

async function retrieveRelevantChunks(
  question: string,
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>,
): Promise<string[]> {
  const guide = await loadGuide();
  logger.info("Step 1 — Retrieval: finding relevant chunks from guide");

  const retrievalPrompt = `You are a retrieval assistant. Given the user's question and the guide index below, return the chunk_ids of the 2-3 most relevant chunks.

Only return chunks with status: active.

GUIDE INDEX:
${guide}

CONVERSATION HISTORY:
${conversationHistory.map((m) => `${m.role}: ${m.content}`).join("\n")}

USER QUESTION: ${question}

Return ONLY a JSON array of chunk_id strings, nothing else. Example: ["chunk-id-1", "chunk-id-2"]
If no chunks are relevant, return: []`;

  const t0 = Date.now();
  let text: string;
  try {
    const result = await breakerCall(() =>
      generateText({ model: model(), prompt: retrievalPrompt }),
    );
    text = result.text;
  } catch (err) {
    logger.warn(
      `Step 1 — retrieval LLM call failed [${classifyLlmError(err)}] — returning empty chunk list`,
      {
        durationMs: Date.now() - t0,
      },
    );
    return [];
  }
  logger.info("Step 1 — retrieval complete", { durationMs: Date.now() - t0 });

  try {
    const ids = JSON.parse(cleanJson(text));
    logger.info(`Step 1 — retrieved chunk IDs: ${ids.join(", ")}`);
    return Array.isArray(ids) ? ids : [];
  } catch {
    logger.warn("Could not parse retrieval response", { text });
    return [];
  }
}

// ─── Response parser ───────────────────────────────────────────────────────────

export function parseChatResponse(raw: string): ChatResponse | ChatResponse[] {
  try {
    const parsed = JSON.parse(cleanJson(raw));
    logger.debug("Chat response type(s) from LLM", {
      types: Array.isArray(parsed)
        ? parsed.map((i: any) => i?.type)
        : parsed?.type,
    });
    if (Array.isArray(parsed)) {
      return parsed.map((item) => {
        try {
          return ChatResponseSchema.parse(item);
        } catch {
          logger.warn(
            `Unrecognised type "${item?.type}" — falling back to text`,
          );
          return {
            type: "text",
            data: { body: JSON.stringify(item) },
          } as ChatResponse;
        }
      });
    }
    return ChatResponseSchema.parse(parsed);
  } catch (err) {
    logger.error("Failed to parse LLM response as ChatResponse", { err });
    return { type: "text", data: { body: raw } };
  }
}

// ─── Step 2: Generation ────────────────────────────────────────────────────────

export type ContextChunk = {
  chunk_id: string;
  topic: string;
  summary: string;
  content: string;
  file: string;
};

export type ChatResult = {
  raw: string;
  parsed: ChatResponse | ChatResponse[];
  contextChunks: ContextChunk[];
};

export async function answerTroubleshootingQuestion(
  question: string,
  conversationHistory: Array<{
    role: "user" | "assistant";
    content: string;
  }> = [],
  mode: "clarify" | "answer" = "answer",
): Promise<ChatResult> {
  logger.info("Calling LLM", { question, mode });

  const chunkIds = await retrieveRelevantChunks(question, conversationHistory);

  const guideRaw = await loadGuide();
  const guideEntries = parseGuideEntries(guideRaw);
  const chunkContents: string[] = [];
  const contextChunks: ContextChunk[] = [];

  if (chunkIds.length > 0) {
    for (const entry of guideEntries) {
      if (!chunkIds.includes(entry.chunk_id)) continue;
      const file = `data/chunks/${entry.chunk_id}.md`;
      try {
        const content = await loadChunk(file);
        chunkContents.push(`=== Chunk: ${entry.chunk_id} ===\n${content}`);
        contextChunks.push({
          chunk_id: entry.chunk_id,
          topic: entry.topic,
          summary: entry.summary,
          content,
          file,
        });
        logger.info(`Loaded chunk: ${entry.chunk_id}`);
      } catch {
        logger.warn(`Could not load chunk file: ${file}`);
      }
    }
  }

  const systemPrompt = await loadPrompt("chat");
  const contextBlock =
    chunkContents.length > 0
      ? `\n\nRELEVANT CHUNK DOCUMENTATION:\n${chunkContents.join("\n\n")}`
      : "\n\nRELEVANT CHUNK DOCUMENTATION:\nNo matching chunks found for this query.";
  const modeBlock = `\n\nCURRENT MODE: ${mode.toUpperCase()}\n${
    mode === "clarify"
      ? "The user needs clarification. Prefer choices or alert responses."
      : "Answer mode. Go directly to steps if documentation supports it."
  }`;

  logger.info(
    `Step 2 — Generating response with ${chunkContents.length} chunk(s) in ${mode} mode`,
  );

  const t0 = Date.now();
  let genText: string;
  try {
    const result = await breakerCall(() =>
      generateText({
        model: model(),
        system: systemPrompt + contextBlock + modeBlock,
        messages: [...conversationHistory, { role: "user", content: question }],
      }),
    );
    genText = result.text;
  } catch (err) {
    const errType = classifyLlmError(err);
    logger.error(`Step 2 — generation LLM call failed [${errType}]`, {
      durationMs: Date.now() - t0,
    });
    const errorResponse = parseChatResponse(
      JSON.stringify({
        type: "alert",
        data: {
          severity: "danger",
          title: "Assistant unavailable",
          body:
            errType === "auth"
              ? "API key error — please check your configuration."
              : errType === "rate_limit"
                ? "The AI provider is rate-limiting requests. Please try again in a moment."
                : "The AI service is temporarily unavailable. Please try again.",
        },
      }),
    );
    return { raw: "", parsed: errorResponse, contextChunks };
  }
  logger.info("Step 2 — generation complete", { durationMs: Date.now() - t0 });
  logger.debug("Raw chat LLM output", { preview: genText.substring(0, 1000) });

  return { raw: genText, parsed: parseChatResponse(genText), contextChunks };
}
