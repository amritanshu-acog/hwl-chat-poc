/**
 * src/scripts/eval-retrieval.ts
 *
 * CLI: bun run score
 *
 * Baseline Retrieval Accuracy Evaluator — Drop 1 Demo (D1-24, D1-25)
 *
 * Reads data/test-queries.json (your "Gold Standard" questions).
 * For each question, calls the retrieval system and checks if the
 * expected chunk_id(s) appear in the results.
 * Prints a detailed report and an overall accuracy score.
 *
 * Exit codes:
 *   0 — all queries hit
 *   1 — one or more queries missed
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { generateText } from "ai";
import { getModel } from "../providers.js";
import { cleanJson } from "../llm-client.js";
import { CONFIG } from "../config.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface TestQuery {
  question: string;
  expected_chunk_ids: string[];
  notes?: string;
}

interface EvalResult {
  question: string;
  expected: string[];
  retrieved: string[];
  hit: boolean;
  notes?: string;
}

// ─── Model ────────────────────────────────────────────────────────────────────

let _model: ReturnType<typeof getModel> | null = null;
function model() {
  if (!_model) _model = getModel();
  return _model;
}

// ─── Retrieval caller ─────────────────────────────────────────────────────────

async function runRetrieval(
  question: string,
  guide: string,
): Promise<string[]> {
  const prompt = `You are a retrieval assistant. Given the user's question and the guide index below, return the chunk_ids of the 2-3 most relevant chunks.

Only return chunks with status: active.

GUIDE INDEX:
${guide}

USER QUESTION: ${question}

Return ONLY a JSON array of chunk_id strings, nothing else. Example: ["chunk-id-1", "chunk-id-2"]
If no chunks are relevant, return: []`;

  const { text } = await generateText({ model: model(), prompt });

  try {
    const ids = JSON.parse(cleanJson(text));
    return Array.isArray(ids) ? ids : [];
  } catch {
    return [];
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n🎯 HWL Knowledge Base — Retrieval Accuracy Evaluator\n");
  console.log("═".repeat(60));

  // Load guide
  let guide: string;
  try {
    guide = await readFile(CONFIG.paths.guide, "utf-8");
  } catch {
    console.error("❌ Could not read guide.yaml. Run bun run ingest first.");
    process.exit(1);
  }

  // Load test queries
  const queriesPath = join(process.cwd(), "data", "test-queries.json");
  let queries: TestQuery[];
  try {
    const raw = await readFile(queriesPath, "utf-8");
    queries = JSON.parse(raw);
  } catch {
    console.error(`❌ Could not read test-queries.json at: ${queriesPath}`);
    process.exit(1);
  }

  console.log(
    `\n📋 Running ${queries.length} test queries against the knowledge base...\n`,
  );

  const results: EvalResult[] = [];
  let passed = 0;
  let failed = 0;

  for (let i = 0; i < queries.length; i++) {
    const q = queries[i]!;
    process.stdout.write(
      `  [${i + 1}/${queries.length}] "${q.question.slice(0, 55)}..." `,
    );

    const retrieved = await runRetrieval(q.question, guide);

    // A "hit" means at least one expected chunk was retrieved
    const hit = q.expected_chunk_ids.some((id) => retrieved.includes(id));

    results.push({
      question: q.question,
      expected: q.expected_chunk_ids,
      retrieved,
      hit,
      notes: q.notes,
    });

    if (hit) {
      console.log("✅ HIT");
      passed++;
    } else {
      console.log("❌ MISS");
      failed++;
    }
  }

  // ── Detailed breakdown ───────────────────────────────────────────────────────
  console.log("\n" + "═".repeat(60));
  console.log("📊 DETAILED RESULTS");
  console.log("═".repeat(60));

  for (const r of results) {
    const icon = r.hit ? "✅" : "❌";
    console.log(`\n${icon} "${r.question}"`);
    if (r.notes) console.log(`   Note:     ${r.notes}`);
    console.log(`   Expected: ${r.expected.join(", ")}`);
    console.log(
      `   Got:      ${r.retrieved.length > 0 ? r.retrieved.join(", ") : "(none)"}`,
    );
    if (!r.hit) {
      const missed = r.expected.filter((id) => !r.retrieved.includes(id));
      console.log(`   ⚠️  Missed: ${missed.join(", ")}`);
    }
  }

  // ── Score ────────────────────────────────────────────────────────────────────
  const score = Math.round((passed / queries.length) * 100);

  console.log("\n" + "═".repeat(60));
  console.log("🏆 RETRIEVAL ACCURACY SCORE");
  console.log("═".repeat(60));
  console.log(`\n   Total queries:   ${queries.length}`);
  console.log(`   Hits:            ${passed}`);
  console.log(`   Misses:          ${failed}`);
  console.log(`\n   ┌─────────────────────────┐`);
  console.log(`   │  Score:  ${score.toString().padStart(3)}%              │`);
  console.log(`   └─────────────────────────┘`);

  if (score === 100) {
    console.log(
      "\n   ✅ Perfect retrieval. All queries returned the correct chunks.\n",
    );
  } else if (score >= 80) {
    console.log(`\n   ⚠️  Good retrieval but ${failed} query/queries missed.`);
    console.log("   Review trigger phrases in the missed chunks to improve.\n");
  } else {
    console.log(
      `\n   ❌ Low retrieval accuracy. Review summaries and triggers in guide.yaml.\n`,
    );
  }

  // ── Save report ──────────────────────────────────────────────────────────────
  try {
    await mkdir(CONFIG.paths.reports, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const reportPath = join(
      CONFIG.paths.reports,
      `eval-retrieval-${timestamp}.json`,
    );
    await writeFile(
      reportPath,
      JSON.stringify(
        { runAt: new Date().toISOString(), score, passed, failed, results },
        null,
        2,
      ),
      "utf-8",
    );
    console.log(`📝 Report saved: ${reportPath}\n`);
  } catch {
    /* non-fatal */
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("❌ Eval failed:", err);
  process.exit(1);
});
