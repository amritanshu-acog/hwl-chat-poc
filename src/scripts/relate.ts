/**
 * bun run relate
 *
 * Reads guide.yaml, sends all chunk summaries to the LLM in a single call,
 * gets back clusters of related chunk_ids, then updates related_chunks in
 * each chunk's .md front matter and rebuilds guide.yaml.
 */

import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { generateText } from "ai";
import { getModel } from "../providers.js";
import { cleanJson, callLlmWithRetry } from "../llm-client.js";
import { execSync } from "child_process";
import { CONFIG } from "../config.js";
import { logger } from "../logger.js";
import { parseGuideEntries } from "../guide-parser.js";

const CHUNKS_DIR = CONFIG.paths.chunks;
const GUIDE_PATH = CONFIG.paths.guide; // path to guide.yaml

// ─── Model ─────────────────────────────────────────────────────────────────────

let _model: ReturnType<typeof getModel> | null = null;
function model() {
  if (!_model) _model = getModel();
  return _model;
}

// ─── Types ─────────────────────────────────────────────────────────────────────

interface GuideChunk {
  chunk_id: string;
  topic: string;
  summary: string;
  status: string;
}

// ─── Get clusters from LLM ─────────────────────────────────────────────────────

async function getClusters(chunks: GuideChunk[]): Promise<string[][]> {
  const chunkList = chunks
    .map(
      (c) =>
        `- chunk_id: ${c.chunk_id}\n  topic: ${c.topic}\n  summary: ${c.summary}`,
    )
    .join("\n\n");

  const prompt = `You are a knowledge base curator. Given the following list of help content chunks, group them into clusters of genuinely related chunks — meaning a customer dealing with one topic in a cluster would likely need the others too.

CHUNKS:
${chunkList}

Rules:
- Each cluster should contain 2–4 chunk_ids that are directly complementary
- A chunk can appear in only one cluster
- Chunks that don't relate to anything should be left out (do not force them into a cluster)
- Return ONLY a JSON array of arrays of chunk_id strings
- No markdown, no explanation, just the JSON

Example:
[
  ["chunk-id-one", "chunk-id-two", "chunk-id-three"],
  ["chunk-id-four", "chunk-id-five"]
]`;

  let text: string;
  try {
    text = (
      await callLlmWithRetry(() => generateText({ model: model(), prompt }))
    ).text;
  } catch (err) {
    logger.error("LLM call failed during relate pass", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  try {
    const cleaned = cleanJson(text);
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed.filter(Array.isArray) : [];
  } catch {
    logger.error("Could not parse clusters response from LLM");
    return [];
  }
}

// ─── Front matter updater ──────────────────────────────────────────────────────

function updateRelatedChunks(raw: string, related: string[]): string {
  const normalised = related.map((r) => r.trim().replace(/^chunk_id:/i, ""));

  const relatedBlock =
    normalised.length > 0
      ? `related_chunks:\n${normalised.map((r) => `  - ${r}`).join("\n")}`
      : `related_chunks:`;

  return raw.replace(
    /^related_chunks:[\s\S]*?(?=^status:)/m,
    `${relatedBlock}\n`,
  );
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  logger.info("Relate pass started (cluster mode)");

  // 1. Read guide.yaml
  let guideRaw: string;
  try {
    guideRaw = await readFile(GUIDE_PATH, "utf-8");
  } catch {
    logger.error("Could not read guide.yaml", { path: GUIDE_PATH });
    process.exit(1);
  }

  const allChunks = parseGuideEntries(guideRaw);
  const activeChunks = allChunks.filter((c) => c.status === "active");

  logger.info("Active chunks loaded", { count: activeChunks.length });

  if (activeChunks.length < 2) {
    logger.warn("Need at least 2 active chunks to find relationships");
    process.exit(0);
  }

  // 2. Single LLM call — get clusters
  logger.info("Sending all chunks to LLM for clustering...");
  const clusters = await getClusters(activeChunks);
  logger.info("Clusters received", { clusterCount: clusters.length, clusters });

  if (clusters.length === 0) {
    logger.warn("No clusters returned — nothing to update");
    process.exit(0);
  }

  // 3. Build a map: chunk_id → related chunk_ids (its cluster minus itself)
  const relatedMap = new Map<string, string[]>();
  for (const cluster of clusters) {
    for (const chunkId of cluster) {
      const others = cluster.filter((id) => id !== chunkId);
      relatedMap.set(chunkId, others);
    }
  }

  // 4. Update each .md file
  let updated = 0;
  for (const chunk of activeChunks) {
    const related = relatedMap.get(chunk.chunk_id) ?? [];
    const filePath = join(CHUNKS_DIR, `${chunk.chunk_id}.md`);

    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch (err) {
      logger.error("Could not read chunk file — skipping", {
        file: filePath,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const updatedContent = updateRelatedChunks(raw, related);
    await writeFile(filePath, updatedContent, "utf-8");

    logger.info("Updated related_chunks", {
      chunkId: chunk.chunk_id,
      related,
    });
    updated++;
  }

  logger.info("Relate pass complete", { totalUpdated: updated });

  // 5. Rebuild guide.yaml
  logger.info("Rebuilding guide.yaml...");
  try {
    execSync("bun run rebuild", { stdio: "inherit" });
  } catch {
    logger.error("Guide rebuild failed — run bun run rebuild manually");
  }

  logger.info("Relate pass done");
}

main().catch((err) => {
  logger.error("Relate pass failed", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
