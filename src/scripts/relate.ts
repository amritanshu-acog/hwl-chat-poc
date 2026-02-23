/**
 * bun run relate
 *
 * Post-aggregation pass. Reads all active chunks, uses the LLM to identify
 * related chunks based on topic and summary, then writes related_chunks back
 * into each chunk's front matter and rebuilds guide.yaml.
 *
 * Run after extraction and validation are complete.
 */

import { readFile, writeFile, readdir } from "fs/promises";
import { join } from "path";
import { generateText } from "ai";
import { getModel } from "../providers.js";
import { cleanJson } from "../llm-client.js";
import { execSync } from "child_process";

const CHUNKS_DIR = join(process.cwd(), "data", "chunks");

// ─── Model ─────────────────────────────────────────────────────────────────────

let _model: ReturnType<typeof getModel> | null = null;
function model() {
  if (!_model) _model = getModel();
  return _model;
}

// ─── Types ─────────────────────────────────────────────────────────────────────

interface ChunkSummary {
  chunk_id: string;
  topic: string;
  summary: string;
  file: string;
  status: string;
}

// ─── Front matter reader ───────────────────────────────────────────────────────

function parseChunkSummary(raw: string, fileName: string): ChunkSummary | null {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;

  const fm = fmMatch[1]!;
  const chunk_id = fm.match(/^chunk_id:\s*(.+)$/m)?.[1]?.trim() ?? "";
  const topic = fm.match(/^topic:\s*(.+)$/m)?.[1]?.trim() ?? "";
  const summary = fm.match(/^summary:\s*>\s*\n\s+(.+)$/m)?.[1]?.trim() ?? "";
  const status = fm.match(/^status:\s*(\w+)$/m)?.[1]?.trim() ?? "active";

  if (!chunk_id || !topic) return null;
  return { chunk_id, topic, summary, file: fileName, status };
}

// ─── Related chunk finder ──────────────────────────────────────────────────────

async function findRelatedChunks(
  target: ChunkSummary,
  allChunks: ChunkSummary[],
): Promise<string[]> {
  const others = allChunks.filter((c) => c.chunk_id !== target.chunk_id);

  if (others.length === 0) return [];

  const candidateList = others
    .map(
      (c) =>
        `- chunk_id: ${c.chunk_id}\n  topic: ${c.topic}\n  summary: ${c.summary}`,
    )
    .join("\n\n");

  const prompt = `You are a knowledge base curator. Given a primary chunk and a list of other chunks, identify which other chunks are genuinely related and would help a customer who is reading the primary chunk.

PRIMARY CHUNK:
chunk_id: ${target.chunk_id}
topic: ${target.topic}
summary: ${target.summary}

OTHER CHUNKS:
${candidateList}

Return ONLY a JSON array of chunk_id strings for chunks that are directly related — meaning a customer dealing with the primary topic would likely need them too.

Rules:
- Only include chunks that are genuinely complementary, not loosely similar
- Maximum 3 related chunks
- If none are truly related, return []
- No markdown, no explanation, just the JSON array

Example: ["chunk-id-one", "chunk-id-two"]`;

  const { text } = await generateText({
    model: model(),
    prompt,
  });

  try {
    const cleaned = cleanJson(text);
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed)
      ? parsed.filter((id: any) => typeof id === "string")
      : [];
  } catch {
    console.warn(
      `  ⚠️  Could not parse related chunks response for ${target.chunk_id}`,
    );
    return [];
  }
}

// ─── Front matter updater ──────────────────────────────────────────────────────

function updateRelatedChunks(raw: string, related: string[]): string {
  const relatedBlock =
    related.length > 0
      ? `related_chunks:\n${related.map((r) => `  - ${r}`).join("\n")}`
      : `related_chunks:`;

  // Replace existing related_chunks block
  return raw.replace(
    /^related_chunks:[\s\S]*?(?=^status:)/m,
    `${relatedBlock}\n`,
  );
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n🔗 Running post-aggregation related chunks pass...\n");

  let files: string[];
  try {
    files = (await readdir(CHUNKS_DIR)).filter((f) => f.endsWith(".md"));
  } catch {
    console.error(`❌ Could not read chunks directory: ${CHUNKS_DIR}`);
    process.exit(1);
  }

  if (files.length === 0) {
    console.warn("⚠️  No chunks found. Run bun run extract first.");
    process.exit(0);
  }

  // Load all chunk summaries
  const allChunks: ChunkSummary[] = [];
  for (const file of files) {
    const raw = await readFile(join(CHUNKS_DIR, file), "utf-8");
    const summary = parseChunkSummary(raw, file);
    if (summary) allChunks.push(summary);
  }

  // Only process active chunks
  const activeChunks = allChunks.filter((c) => c.status === "active");
  console.log(`📂 Processing ${activeChunks.length} active chunk(s)...\n`);

  if (activeChunks.length < 2) {
    console.log("ℹ️  Need at least 2 active chunks to find relationships.\n");
    process.exit(0);
  }

  let updated = 0;

  for (const chunk of activeChunks) {
    process.stdout.write(`  Relating ${chunk.chunk_id}... `);

    const related = await findRelatedChunks(chunk, activeChunks);
    const filePath = join(CHUNKS_DIR, chunk.file);
    const raw = await readFile(filePath, "utf-8");
    const updatedContent = updateRelatedChunks(raw, related);

    await writeFile(filePath, updatedContent, "utf-8");

    if (related.length > 0) {
      console.log(`✓ [${related.join(", ")}]`);
    } else {
      console.log(`✓ [none]`);
    }

    updated++;
  }

  console.log(`\n✅ Related chunks written for ${updated} chunk(s)`);

  // Rebuild guide to reflect related_chunks changes
  console.log(`\n🔨 Rebuilding guide.yaml...\n`);
  try {
    execSync("bun run rebuild", { stdio: "inherit" });
  } catch {
    console.error("❌ Guide rebuild failed. Run bun run rebuild manually.");
  }

  console.log("✅ Done.\n");
}

main().catch((err) => {
  console.error("❌ Relate pass failed:", err);
  process.exit(1);
});
