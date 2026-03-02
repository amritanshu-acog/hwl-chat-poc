/**
 * generation/src/pipeline/related-chunks.ts
 *
 * Related Chunks Computation — §8 of the design spec.
 *
 * Steps:
 *   1. Normalise triggers — convert question-phrased triggers to noun phrases via LLM
 *   2. Embed — build one text string per chunk, send all to embedding model in one call
 *   3. Pairwise cosine similarity — mark both directions related if ≥ threshold
 *   4. BFS cluster report — connected components
 *
 * Failure is non-fatal — caller logs warning and continues.
 */

import { CONFIG } from "../core/config.js";
import { callLlmJson, loadPromptFile } from "../core/llm.js";
import { withBackoff } from "../utils/backoff.js";
import type { StageLogger } from "../core/logger.js";
import type { GuideEntry } from "./compile.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface NormalisedChunk {
  chunk_id: string;
  triggers: string[];
}

interface ClusterChunk {
  chunk_id: string;
  topic: string;
  relations: number;
}

interface Cluster {
  size: number;
  chunks: ClusterChunk[];
}

export interface RelatedChunksResult {
  model: string;
  threshold: number;
  clusters: Cluster[];
  /** Map of chunk_id → related chunk_ids (symmetric). Consumed by compile. */
  relatedMap: Map<string, string[]>;
}

// ─── Step 1: Trigger normalisation ───────────────────────────────────────────

async function normaliseTriggers(
  entries: GuideEntry[],
  log: StageLogger,
): Promise<Map<string, string[]>> {
  log.info("Related chunks: normalising triggers", { chunks: entries.length });

  const normalisePrompt = loadPromptFile(CONFIG.prompts.normalize_triggers);

  // Build input payload
  const input = {
    chunks: entries.map((e) => ({
      chunk_id: e.chunk_id,
      triggers: e.triggers,
    })),
  };

  const result = await withBackoff(
    () =>
      callLlmJson(
        {
          system: normalisePrompt,
          prompt: `Normalise the triggers in this JSON. Return JSON only.\n\n${JSON.stringify(input)}`,
          model: CONFIG.related_chunks.normalize_model,
          temperature: 0,
          maxTokens: 8000,
        },
        log,
      ),
    log,
  );

  // Parse response
  let parsed: { chunks?: NormalisedChunk[] };
  try {
    const cleaned = result.text
      .replace(/```json\s*/gi, "")
      .replace(/```\s*/g, "")
      .trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    log.warn("Failed to parse normalised triggers — using original triggers", {
      error: String(err),
    });
    // Fall back to original triggers
    const map = new Map<string, string[]>();
    for (const e of entries) map.set(e.chunk_id, e.triggers);
    return map;
  }

  const map = new Map<string, string[]>();
  const normalisedChunks = parsed.chunks ?? [];

  for (const e of entries) {
    const found = normalisedChunks.find((c) => c.chunk_id === e.chunk_id);
    map.set(e.chunk_id, found?.triggers ?? e.triggers);
  }

  log.info("Triggers normalised", { chunks: map.size });
  return map;
}

// ─── Step 2: Embedding ────────────────────────────────────────────────────────

async function embedChunks(
  entries: GuideEntry[],
  normalisedTriggers: Map<string, string[]>,
  log: StageLogger,
): Promise<Map<string, number[]>> {
  log.info("Related chunks: embedding", {
    model: CONFIG.related_chunks.model,
    chunks: entries.length,
  });

  // Build one text string per chunk
  const texts = entries.map((e) => {
    const triggers = normalisedTriggers.get(e.chunk_id) ?? e.triggers;
    return `${e.topic}. ${e.summary} ${triggers.join(" ")}`;
  });

  const response = await fetch(
    `${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${CONFIG.related_chunks.model}/embeddings?api-version=${process.env.AZURE_API_VERSION ?? "2024-12-01-preview"}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": process.env.AZURE_API_KEY ?? "",
      },
      body: JSON.stringify({
        input: texts,
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Embedding API error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as {
    data: Array<{ index: number; embedding: number[] }>;
  };

  const embeddingMap = new Map<string, number[]>();
  for (const item of data.data) {
    const entry = entries[item.index];
    if (entry) {
      embeddingMap.set(entry.chunk_id, item.embedding);
    }
  }

  log.info("Embeddings received", { count: embeddingMap.size });
  return embeddingMap;
}

// ─── Step 3: Cosine similarity ────────────────────────────────────────────────

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    magA += (a[i] ?? 0) ** 2;
    magB += (b[i] ?? 0) ** 2;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function computeSimilarity(
  entries: GuideEntry[],
  embeddingMap: Map<string, number[]>,
  threshold: number,
  log: StageLogger,
): Map<string, string[]> {
  log.info("Related chunks: computing pairwise cosine similarity", {
    threshold,
    pairs: Math.floor((entries.length * (entries.length - 1)) / 2),
  });

  const relatedMap = new Map<string, string[]>();
  for (const e of entries) relatedMap.set(e.chunk_id, []);

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i]!;
      const b = entries[j]!;
      const embA = embeddingMap.get(a.chunk_id);
      const embB = embeddingMap.get(b.chunk_id);
      if (!embA || !embB) continue;

      const sim = cosine(embA, embB);
      if (sim >= threshold) {
        relatedMap.get(a.chunk_id)!.push(b.chunk_id);
        relatedMap.get(b.chunk_id)!.push(a.chunk_id);
      }
    }
  }

  const totalLinks = [...relatedMap.values()].reduce((s, v) => s + v.length, 0);
  log.info("Similarity complete", { totalRelatedLinks: totalLinks });

  return relatedMap;
}

// ─── Step 4: BFS cluster report ───────────────────────────────────────────────

function buildClusters(
  entries: GuideEntry[],
  relatedMap: Map<string, string[]>,
): Cluster[] {
  const visited = new Set<string>();
  const clusters: Cluster[] = [];
  const topicMap = new Map(entries.map((e) => [e.chunk_id, e.topic]));

  for (const entry of entries) {
    if (visited.has(entry.chunk_id)) continue;

    // BFS
    const queue = [entry.chunk_id];
    const component: string[] = [];
    visited.add(entry.chunk_id);

    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);
      for (const neighbor of relatedMap.get(current) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    // Only report clusters with more than 1 member (isolated nodes are not clusters)
    if (component.length > 1) {
      clusters.push({
        size: component.length,
        chunks: component.map((id) => ({
          chunk_id: id,
          topic: topicMap.get(id) ?? "",
          relations: (relatedMap.get(id) ?? []).length,
        })),
      });
    }
  }

  return clusters.sort((a, b) => b.size - a.size);
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Compute related_chunks for all entries.
 * Returns RelatedChunksResult including the relatedMap for compile to write back.
 * Throws on failure — caller handles as non-fatal.
 */
export async function computeRelatedChunks(
  entries: GuideEntry[],
  log: StageLogger,
): Promise<RelatedChunksResult> {
  if (entries.length === 0) {
    log.info("No entries — skipping related chunks");
    return {
      model: CONFIG.related_chunks.model,
      threshold: CONFIG.related_chunks.threshold,
      clusters: [],
      relatedMap: new Map(),
    };
  }

  // Step 1: Normalise triggers
  const normalisedTriggers = await normaliseTriggers(entries, log);

  // Step 2: Embed
  const embeddingMap = await embedChunks(entries, normalisedTriggers, log);

  // Step 3: Cosine similarity
  const relatedMap = computeSimilarity(
    entries,
    embeddingMap,
    CONFIG.related_chunks.threshold,
    log,
  );

  // Step 4: BFS clusters
  const clusters = buildClusters(entries, relatedMap);

  log.info("Related chunks complete", { clusters: clusters.length });

  return {
    model: CONFIG.related_chunks.model,
    threshold: CONFIG.related_chunks.threshold,
    clusters,
    relatedMap,
  };
}
