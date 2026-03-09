import { generateText } from "ai";
import { readFile } from "fs/promises";
import { join } from "path";
import { getModel } from "../llm/providers.js";
import { getPrompt } from "../resources/resources.js";
import { CONFIG } from "../core/config.js";
import { logger } from "../core/logger.js";
import { cleanJson, callLlmWithRetry } from "../llm/client.js";
import {
  RespondOutputSchema,
  type RespondOutput,
  type Citation,
  type GuideEntry,
} from "../core/schemas.js";
import type { ConversationTurn } from "../session/session.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/** A chunk file loaded from final/ and ready to be sent to the respond LLM. */
interface LoadedChunk {
  chunk_id: string;
  source: string;
  body: string; // markdown body with front matter stripped
}

export interface ResponderResult {
  respondOutput: RespondOutput;
  citations: Citation[];
  loadedChunkIds: string[]; // IDs of all chunks loaded (not just cited ones)
}

// ─── Chunk file parsing ───────────────────────────────────────────────────────

/**
 * Parse a raw chunk .md file into front matter fields and a clean markdown body.
 *
 * Front matter format:
 *   ---
 *   chunk_id: <id>
 *   source: <filename>
 *   ...other fields...
 *   ---
 *   <markdown body>
 */
function parseChunkFile(
  raw: string,
): { chunk_id: string; source: string; body: string } | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match || match[1] == null || match[2] == null) return null;

  const fm: string = match[1];
  const body: string = match[2].trim();

  const chunk_id = fm.match(/^chunk_id:\s*(.+)$/m)?.[1]?.trim() ?? "";
  const source = fm.match(/^source:\s*(.+)$/m)?.[1]?.trim() ?? "";

  if (!chunk_id || !source) return null;
  return { chunk_id, source, body };
}

/**
 * Format a loaded chunk as a labelled block for the respond LLM.
 *
 * The heading format `### Chunk [<id>] (source: <filename>)` is what the
 * respond prompt instructs the LLM to use when reporting cited_chunk_ids.
 */
function buildChunkBlock(chunk: LoadedChunk): string {
  return `### Chunk [${chunk.chunk_id}] (source: ${chunk.source})\n\n${chunk.body}`;
}

// ─── Message construction ─────────────────────────────────────────────────────

function buildRespondUserMessage(
  windowTurns: ConversationTurn[],
  chunkBlocks: string[],
): string {
  const history = windowTurns.map((t) => `${t.role}: ${t.content}`).join("\n");

  return [
    "CONVERSATION HISTORY:",
    history,
    "",
    "KNOWLEDGE BASE CHUNKS:",
    chunkBlocks.join("\n\n---\n\n"),
  ].join("\n");
}

// ─── Responder ────────────────────────────────────────────────────────────────

/**
 * Load the chunk files identified by triage, call the respond LLM, and
 * build the citations list from cited_chunk_ids reported by the LLM.
 *
 * Returns null if no chunk files could be loaded — the pipeline will then
 * serve default.md without making a respond LLM call.
 *
 * GAP FIX #1/#10: passes CONFIG.models.respond to getModel() for per-stage
 * model selection.
 *
 * @param chunkIds     Chunk IDs returned by triage (already includes related_chunks).
 * @param windowTurns  Current window turns for conversation context.
 * @param guideEntries Parsed guide entries — used to resolve source filenames.
 */
export async function runResponder(
  chunkIds: string[],
  windowTurns: ConversationTurn[],
  guideEntries: GuideEntry[],
): Promise<ResponderResult | null> {
  // Deduplicate before loading.
  const uniqueIds = [...new Set(chunkIds)];

  // Source lookup by chunk_id — used as a fallback if front matter parse fails.
  const guideSourceMap = new Map<string, string>(
    guideEntries.map((e) => [e.chunk_id, e.source]),
  );

  // ── Load chunk files ───────────────────────────────────────────────────────

  const loadedChunks: LoadedChunk[] = [];

  for (const id of uniqueIds) {
    const filePath = join(CONFIG.paths.chunks, `${id}.md`);
    try {
      const raw = await readFile(filePath, "utf-8");
      const parsed = parseChunkFile(raw);

      if (parsed) {
        loadedChunks.push(parsed);
      } else {
        // Front matter parse failed — fall back to guide source + raw body.
        logger.warn("Could not parse chunk front matter", { id, filePath });
        const fallbackSource = guideSourceMap.get(id) ?? "unknown";
        loadedChunks.push({ chunk_id: id, source: fallbackSource, body: raw });
      }
    } catch {
      logger.warn("Chunk file not found", { id, filePath });
    }
  }

  // If nothing loaded, signal the pipeline to fall back to default.md.
  if (loadedChunks.length === 0) {
    logger.warn("No chunk files loaded — will serve fallback", {
      requested: uniqueIds,
    });
    return null;
  }

  // ── Build chunk source map from loaded files (more accurate than guide) ────

  const loadedSourceMap = new Map<string, string>(
    loadedChunks.map((c) => [c.chunk_id, c.source]),
  );

  // ── Call respond LLM ───────────────────────────────────────────────────────

  const systemPrompt = await getPrompt(CONFIG.prompts.respond);
  const chunkBlocks = loadedChunks.map(buildChunkBlock);
  const userMessage = buildRespondUserMessage(windowTurns, chunkBlocks);

  const t0 = Date.now();

  // GAP FIX #1/#10: use the respond-specific model.
  const result = await callLlmWithRetry(() =>
    generateText({
      model: getModel(CONFIG.models.respond),
      system: systemPrompt,
      prompt: userMessage,
      temperature: CONFIG.temperature.respond,
    }),
  );

  logger.debug("responder raw output", {
    durationMs: Date.now() - t0,
    chunksProvided: loadedChunks.length,
    preview: result.text.slice(0, 300),
  });

  const respondOutput = RespondOutputSchema.parse(
    JSON.parse(cleanJson(result.text)),
  );

  // ── Build citations from cited_chunk_ids ───────────────────────────────────
  // Only include chunks that the LLM reported actually using — not all loaded ones.

  const citations: Citation[] = respondOutput.cited_chunk_ids
    .filter((id) => loadedSourceMap.has(id) || guideSourceMap.has(id))
    .map((id) => ({
      chunk_id: id,
      source: loadedSourceMap.get(id) ?? guideSourceMap.get(id) ?? "unknown",
    }));

  logger.info("responder", {
    type: respondOutput.type,
    chunksLoaded: loadedChunks.length,
    citedChunks: citations.length,
    durationMs: Date.now() - t0,
  });

  return {
    respondOutput,
    citations,
    loadedChunkIds: loadedChunks.map((c) => c.chunk_id),
  };
}
