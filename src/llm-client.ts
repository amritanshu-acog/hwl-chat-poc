import { generateText } from "ai";
import { getModel } from "./providers.js";
import { loadPrompt } from "./prompt-loader.js";
import { LLMChunkOutputSchema, ChatResponseSchema } from "./schemas.js";
import { ZodError } from "zod";
import type { ChatResponse, LLMChunkOutput } from "./schemas.js";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { CONFIG } from "./config.js";

// ─── Lazy-initialised model ────────────────────────────────────────────────────

let _model: ReturnType<typeof getModel> | null = null;

function model() {
  if (!_model) _model = getModel();
  return _model;
}

// ─── Circuit Breaker ───────────────────────────────────────────────────────────
//
// Three states:
//   CLOSED    — normal operation, all calls go through
//   OPEN      — threshold consecutive failures hit; calls fail-fast immediately
//   HALF_OPEN — one probe allowed after resetMs; success → CLOSED, fail → OPEN
//
// Thresholds are read from CONFIG.server so they can be tuned via env vars
// without code changes. See config.ts for CIRCUIT_BREAKER_THRESHOLD and
// CIRCUIT_BREAKER_RESET_MS.

type BreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

const breaker = {
  state: "CLOSED" as BreakerState,
  failures: 0,
  openedAt: 0,
};

export function getBreakerState(): BreakerState {
  return breaker.state;
}

function breakerCall<T>(fn: () => Promise<T>): Promise<T> {
  const { circuitBreakerThreshold, circuitBreakerResetMs } = CONFIG.server;
  const now = Date.now();

  // OPEN → check if reset window has elapsed to allow a probe
  if (breaker.state === "OPEN") {
    if (now - breaker.openedAt >= circuitBreakerResetMs) {
      breaker.state = "HALF_OPEN";
      console.warn("⚡ Circuit breaker: HALF_OPEN — sending probe request");
    } else {
      const remainingMs = circuitBreakerResetMs - (now - breaker.openedAt);
      return Promise.reject(
        new Error(
          `Circuit breaker OPEN — LLM provider unavailable. Retrying in ${Math.ceil(remainingMs / 1000)}s.`,
        ),
      );
    }
  }

  return fn().then(
    (result) => {
      // Success — reset failure counter and close the breaker
      if (breaker.state !== "CLOSED") {
        console.log("✅ Circuit breaker: probe succeeded — CLOSED");
      }
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
        console.error(
          `❌ Circuit breaker: OPEN after ${breaker.failures} consecutive failure(s). ` +
            `Will retry in ${circuitBreakerResetMs / 1000}s.`,
        );
      }
      throw err;
    },
  );
}

/**
 * Convenience wrapper: runs fn() through the circuit breaker with one retry
 * on transient errors (2 s delay). Used by validate.ts and relate.ts.
 */
export async function callLlmWithRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await breakerCall(fn);
  } catch {
    await new Promise((r) => setTimeout(r, 2_000));
    return breakerCall(fn); // let the second error propagate
  }
}

// ─── Guide loader ──────────────────────────────────────────────────────────────

const GUIDE_PATH = join(process.cwd(), "data", "guide.yaml");
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
  // filePath from guide.yaml is relative, e.g. "data/chunks/foo.md"
  // Resolve it against the project root (process.cwd())
  const fullPath = join(process.cwd(), filePath);
  return readFile(fullPath, "utf-8");
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
  let depth = 0;
  let endIndex = -1;
  let inString = false;
  let escapeNext = false;

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
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) {
        endIndex = i;
        break;
      }
    }
  }

  if (endIndex !== -1) cleaned = cleaned.slice(0, endIndex + 1).trim();
  cleaned = cleaned.replace(/,\s*}/g, "}").replace(/,\s*]/g, "]");

  return cleaned;
}

// ─── LLM Error Classification ─────────────────────────────────────────────────

export type LlmErrorType =
  | "rate_limit" // 429 — back off and retry
  | "auth" // 401 / 403 — bad API key, do not retry
  | "token_limit" // context / token exceeded — truncation needed, do not retry
  | "transient" // 5xx / network — retry with backoff
  | "unknown"; // anything else

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
  ) {
    return "auth";
  }
  if (
    status === 429 ||
    msg.includes("rate limit") ||
    msg.includes("too many requests") ||
    msg.includes("quota")
  ) {
    return "rate_limit";
  }
  if (
    msg.includes("token") ||
    msg.includes("context length") ||
    msg.includes("maximum context") ||
    msg.includes("content too large") ||
    status === 413
  ) {
    return "token_limit";
  }
  if (status !== undefined && status >= 500) {
    return "transient";
  }
  return "unknown";
}

/** Exponential backoff with optional jitter — parameters come from CONFIG.extraction */
function sleep(attempt: number): Promise<void> {
  const base = CONFIG.extraction.retryBaseDelayMs;
  const cap = CONFIG.extraction.retryMaxDelayMs;

  let ms = Math.min(base * Math.pow(2, attempt), cap);

  if (CONFIG.extraction.retryJitter) {
    // ±20% jitter — prevents thundering herd when parallel extractions all
    // hit a rate limit at the same time and would otherwise all retry together
    const jitterFactor = 1 + (Math.random() * 0.4 - 0.2); // 0.8 – 1.2
    ms = Math.round(ms * jitterFactor);
  }

  console.warn(
    `⏳ Backoff: waiting ${ms}ms before retry (attempt ${attempt + 1})...`,
  );
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
    console.error(
      "❌ extractChunksFromDocument received empty content. Aborting.",
    );
    return [];
  }

  console.log(
    `📤 Sending request to LLM for ${extractionType} extraction...\n`,
  );

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

Required fields for every chunk: chunk_id, topic, summary, triggers, has_conditions, escalation, related_chunks, status, context, response, escalation_detail.

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

  const messages = [
    {
      role: "user" as const,
      content: contentArray,
    },
  ];

  let text: string;
  const maxRetries = CONFIG.extraction.llmRetries ?? 2;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      console.warn(
        `⚠️  Retrying extraction (attempt ${attempt + 1}/${maxRetries + 1})...\n`,
      );
    }
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

      if (errType === "auth") {
        console.error(
          "❌ Authentication error — check your API key. Aborting retries.",
          error,
        );
        break; // no point retrying a bad key
      } else if (errType === "token_limit") {
        console.error(
          "❌ Token / context limit exceeded — segment may be too large. Aborting retries.",
          error,
        );
        break; // retrying with the same content won't help
      } else {
        console.error(
          `❌ LLM call failed [${errType}] during extraction (attempt ${attempt + 1}):`,
          error,
        );
        if (attempt < maxRetries) await sleep(attempt);
      }
      continue; // retry
    }

    const cleaned = cleanJson(text);

    let parsed: any;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      lastError = parseErr;

      // Dump raw response to disk for inspection
      try {
        const reportsDir = CONFIG.paths.reports;
        await mkdir(reportsDir, { recursive: true });
        const debugFile = join(reportsDir, `llm-raw-debug-${Date.now()}.txt`);
        await writeFile(debugFile, text, "utf-8");
        console.error(
          `⚠️  LLM returned invalid JSON during extraction (attempt ${attempt + 1}).`,
        );
        console.error("Parse error:", parseErr);
        console.error(`Raw response saved to: ${debugFile}`);
        console.error(
          "Cleaned string (first 500 chars):",
          cleaned.substring(0, 500),
        );
      } catch {
        console.error("⚠️  LLM returned invalid JSON during extraction.");
        console.error("Parse error:", parseErr);
        console.error(
          "Cleaned string (first 500 chars):",
          cleaned.substring(0, 500),
        );
      }

      continue; // retry
    }

    // ── Parse succeeded ─────────────────────────────────────────────────────────────────────
    const arr: any[] = Array.isArray(parsed) ? parsed : [parsed];

    console.log(`\n🔎 Parsed ${arr.length} chunk(s) from LLM output:`);
    arr.forEach((item, i) => {
      console.log(`  [${i}] chunk_id:       ${item?.chunk_id ?? "MISSING"}`);
      console.log(`       topic:          ${item?.topic ?? "MISSING"}`);
      console.log(
        `       has_conditions: ${item?.has_conditions ?? "MISSING"}`,
      );
      console.log(`       triggers:       ${item?.triggers?.length ?? 0}`);
      console.log(`       has context:    ${!!item?.context}`);
      console.log(`       has response:   ${!!item?.response}`);
    });
    console.log("");

    const validated: LLMChunkOutput[] = [];
    for (const item of arr) {
      if (item?.has_conditions === true && !item?.conditions) {
        console.warn(
          `  ⚠️  chunk "${item?.chunk_id}" has has_conditions:true but no conditions field — flagging for review`,
        );
        item.status = "review";
      }

      try {
        validated.push(LLMChunkOutputSchema.parse(item));
      } catch (err) {
        if (err instanceof ZodError) {
          console.error(
            `  ✗ Validation failed for "${item?.chunk_id ?? "unknown"}":`,
          );
          err.issues.forEach((issue) => {
            console.error(
              `     • ${issue.path.join(".") || "(root)"}: ${issue.message}`,
            );
          });
        } else {
          console.error(
            `  ✗ Unexpected error for "${item?.chunk_id ?? "unknown"}":`,
            err,
          );
        }
      }
    }

    console.log(
      `✅ ${validated.length} chunk(s) validated from LLM extraction\n`,
    );
    return validated;
  }

  // All retries exhausted
  console.error(
    `❌ All ${maxRetries + 1} extraction attempt(s) failed. Returning empty array.`,
  );
  return [];
}

// ─── Step 1: Retrieval ─────────────────────────────────────────────────────────

async function retrieveRelevantChunks(
  question: string,
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>,
): Promise<string[]> {
  const guide = await loadGuide();

  console.log("🔍 Step 1 — Retrieval: finding relevant chunks from guide...");

  const retrievalPrompt = `You are a retrieval assistant. Given the user's question and the guide index below, return the chunk_ids of the 2-3 most relevant chunks.

Only return chunks with status: active.

GUIDE INDEX:
${guide}

CONVERSATION HISTORY:
${conversationHistory.map((m) => `${m.role}: ${m.content}`).join("\n")}

USER QUESTION: ${question}

Return ONLY a JSON array of chunk_id strings, nothing else. Example: ["chunk-id-1", "chunk-id-2"]
If no chunks are relevant, return: []`;

  // Perf timing: retrieval LLM call (GAP-D1-16)
  console.time("⏱  Step 1 — retrieval");
  let text: string;
  try {
    const result = await breakerCall(() =>
      generateText({
        model: model(),
        prompt: retrievalPrompt,
      }),
    );
    text = result.text;
  } catch (err) {
    const errType = classifyLlmError(err);
    console.warn(
      `⚠️  Step 1 — retrieval LLM call failed [${errType}]. Returning empty chunk list.`,
      err,
    );
    console.timeEnd("⏱  Step 1 — retrieval");
    return [];
  }
  console.timeEnd("⏱  Step 1 — retrieval");

  try {
    const clean = cleanJson(text);
    const ids = JSON.parse(clean);
    console.log(`🔍 Step 1 — Retrieved chunk IDs: ${ids.join(", ")}\n`);
    return Array.isArray(ids) ? ids : [];
  } catch {
    console.warn("⚠️  Could not parse retrieval response:", text);
    return [];
  }
}

// ─── Response parser ───────────────────────────────────────────────────────────

export function parseChatResponse(raw: string): ChatResponse | ChatResponse[] {
  try {
    const clean = cleanJson(raw);
    const parsed = JSON.parse(clean);

    console.log(
      "🔎 Chat response type(s) from LLM:",
      Array.isArray(parsed) ? parsed.map((i: any) => i?.type) : parsed?.type,
    );

    if (Array.isArray(parsed)) {
      return parsed.map((item) => {
        try {
          return ChatResponseSchema.parse(item);
        } catch {
          console.warn(
            `⚠️  Unrecognised type "${item?.type}" — falling back to text`,
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
    console.error("⚠️  Failed to parse LLM response as ChatResponse:", err);
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
  console.log("🔍 Calling LLM...");
  console.log("Question:", question);
  console.log("Mode:", mode);

  // ── Step 1: retrieve chunk IDs ───────────────────────────────────────────────
  const chunkIds = await retrieveRelevantChunks(question, conversationHistory);

  // ── Load chunk files ─────────────────────────────────────────────────────────
  const guide = await loadGuide();
  const chunkContents: string[] = [];
  const contextChunks: ContextChunk[] = [];

  if (chunkIds.length > 0) {
    const blocks = guide.split(/^\s{2}- chunk_id:/m).filter((b) => b.trim());

    for (const block of blocks) {
      const chunk_id = block.match(/^\s*([^\n]+)/)?.[1]?.trim() ?? "";
      if (chunkIds.includes(chunk_id)) {
        // Derive the chunk file path from chunk_id — guide.yaml has no `file:` field.
        // Chunks are always stored as data/chunks/<chunk_id>.md
        const file = `data/chunks/${chunk_id}.md`;
        const topic =
          block.match(/\n\s+topic:\s*(.+)/)?.[1]?.trim() ?? "Unknown";
        const summary =
          block.match(/summary:\s*>\s*\n\s+(.+)/)?.[1]?.trim() ?? "No summary";
        try {
          const content = await loadChunk(file);
          chunkContents.push(`=== Chunk: ${chunk_id} ===\n${content}`);
          contextChunks.push({ chunk_id, topic, summary, content, file });
          console.log(`📦 Loaded chunk: ${chunk_id}`);
        } catch {
          console.warn(`⚠️  Could not load chunk file: ${file}`);
        }
      }
    }
  }

  // ── Step 2: generate structured JSON response ────────────────────────────────
  const systemPrompt = await loadPrompt("chat");

  const contextBlock =
    chunkContents.length > 0
      ? `\n\nRELEVANT CHUNK DOCUMENTATION:\n${chunkContents.join("\n\n")}`
      : "\n\nRELEVANT CHUNK DOCUMENTATION:\nNo matching chunks found for this query.";

  const modeBlock = `\n\nCURRENT MODE: ${mode.toUpperCase()}\n${
    mode === "clarify"
      ? "The user needs clarification. Prefer choices or alert responses. Do not jump to full steps unless the situation is already unambiguous."
      : "Answer mode. If the documentation supports it, go directly to steps. Do not ask unnecessary clarifying questions."
  }`;

  console.log(
    `📦 Step 2 — Generating response with ${chunkContents.length} chunk(s) in ${mode} mode...\n`,
  );

  // Perf timing: generation LLM call (GAP-D1-16)
  console.time("⏱  Step 2 — generation");
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
    console.error(`❌ Step 2 — generation LLM call failed [${errType}]:`, err);
    console.timeEnd("⏱  Step 2 — generation");
    // Return a safe user-facing error response rather than throwing
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
  console.timeEnd("⏱  Step 2 — generation");

  console.log("🔎 Raw chat LLM output:", genText.substring(0, 1000));

  const parsed = parseChatResponse(genText);

  return { raw: genText, parsed, contextChunks };
}
