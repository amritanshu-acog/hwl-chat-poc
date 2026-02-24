import { generateText } from "ai";
import { getModel } from "./providers.js";
import { loadPrompt } from "./prompt-loader.js";
import { LLMChunkOutputSchema, ChatResponseSchema } from "./schemas.js";
import { ZodError } from "zod";
import type { ChatResponse, LLMChunkOutput } from "./schemas.js";
import { readFile } from "fs/promises";
import { join } from "path";
import { CONFIG } from "./config.js";

// ─── Lazy-initialised model ────────────────────────────────────────────────────

let _model: ReturnType<typeof getModel> | null = null;

function model() {
  if (!_model) _model = getModel();
  return _model;
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

// ─── Chunk Extraction ──────────────────────────────────────────────────────────

export async function extractChunksFromDocument(
  pdfBase64: string,
  overridePrompt?: string,
  extractionType: "procedure" | "qna" = "procedure",
): Promise<LLMChunkOutput[]> {
  if (!pdfBase64 || pdfBase64.trim().length === 0) {
    console.error(
      "❌ extractChunksFromDocument received empty content. Aborting.",
    );
    return [];
  }

  console.log(`📤 Sending PDF to LLM for ${extractionType} extraction...\n`);

  const systemPrompt = await loadPrompt(
    extractionType === "qna" ? "qna-extraction" : "extraction",
  );

  const userMessage =
    overridePrompt ??
    `Read every page of this PDF carefully and thoroughly.

Your task:
1. Identify ALL distinct processes, procedures, troubleshooting flows, and how-to guides.
2. Extract EVERY image, screenshot, diagram, and visual element with exhaustive descriptions.
3. Produce one chunk object per distinct concept — do not merge, do not skip.

Required fields for every chunk: chunk_id, topic, summary, triggers, has_conditions, escalation, related_chunks, status, context, response, escalation_detail, image_descriptions.

Optional fields (include ONLY when applicable): conditions (only if has_conditions is true), constraints (only if hard system limits exist).

Return ONLY a raw JSON array. Start with [ and end with ]. No markdown fences. No explanation.`;

  const messages = [
    {
      role: "user" as const,
      content: [
        { type: "text" as const, text: userMessage },
        {
          type: "file" as const,
          data: pdfBase64,
          mediaType: "application/pdf",
        },
      ],
    },
  ];

  let text: string;
  try {
    const result = await generateText({
      model: model(),
      system: systemPrompt,
      messages,
    });
    text = result.text;
  } catch (error) {
    console.error("❌ LLM call failed during extraction:", error);
    throw error;
  }

  const cleaned = cleanJson(text);

  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch (parseErr) {
    console.error("⚠️  LLM returned invalid JSON during extraction.");
    console.error("Parse error:", parseErr);
    console.error(
      "Cleaned string (first 500 chars):",
      cleaned.substring(0, 500),
    );
    return [];
  }

  const arr: any[] = Array.isArray(parsed) ? parsed : [parsed];

  console.log(`\n🔎 Parsed ${arr.length} chunk(s) from LLM output:`);
  arr.forEach((item, i) => {
    console.log(`  [${i}] chunk_id:       ${item?.chunk_id ?? "MISSING"}`);
    console.log(`       topic:          ${item?.topic ?? "MISSING"}`);
    console.log(`       has_conditions: ${item?.has_conditions ?? "MISSING"}`);
    console.log(`       triggers:       ${item?.triggers?.length ?? 0}`);
    console.log(
      `       images:         ${item?.image_descriptions?.length ?? 0}`,
    );
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
  const { text } = await generateText({
    model: model(),
    prompt: retrievalPrompt,
  });
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
        const file = block.match(/\n\s+file:\s*(.+)/)?.[1]?.trim();
        const topic =
          block.match(/\n\s+topic:\s*(.+)/)?.[1]?.trim() ?? "Unknown";
        const summary =
          block.match(/summary:\s*>\s*\n\s+(.+)/)?.[1]?.trim() ?? "No summary";
        if (file) {
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
  const { text } = await generateText({
    model: model(),
    system: systemPrompt + contextBlock + modeBlock,
    messages: [...conversationHistory, { role: "user", content: question }],
  });
  console.timeEnd("⏱  Step 2 — generation");

  console.log("🔎 Raw chat LLM output:", text.substring(0, 1000));

  const parsed = parseChatResponse(text);

  return { raw: text, parsed, contextChunks };
}
