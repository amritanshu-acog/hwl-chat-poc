/**
 * server/tests/golden/run.ts
 *
 * Golden dataset test runner — GAP FIX #11.
 *
 * Reads dataset.yaml, runs each question through the pipeline, and checks:
 *   - action === "respond"
 *   - At least one citation has source === expected_source
 *
 * Run: bun server/tests/golden/run.ts
 * Run smoke only: bun server/tests/golden/run.ts --tag=smoke
 *
 * Re-run after every compile, delete, or prompt change.
 */

import { readFile } from "fs/promises";
import { join } from "path";
import { parseArgs } from "util";
import { runPipeline } from "../../pipeline/pipeline.js";
import { preload } from "../../resources/resources.js";

// ─── Args ─────────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: { tag: { type: "string" } },
  strict: false,
});
const filterTag = args.tag as string | undefined;

// ─── Dataset loader ───────────────────────────────────────────────────────────

interface TestCase {
  question: string;
  expected_source: string;
  tags: string[];
  notes?: string;
}

async function loadDataset(): Promise<TestCase[]> {
  const raw = await readFile(
    join(import.meta.dirname, "dataset.yaml"),
    "utf-8",
  );

  // Simple YAML list parser for this known structure.
  const entries: TestCase[] = [];
  const blocks = raw.split(/^  - /m).slice(1);

  for (const block of blocks) {
    try {
      const question = block.match(/question:\s*"([^"]+)"/)?.[1] ?? "";
      const expected_source =
        block.match(/expected_source:\s*"([^"]+)"/)?.[1] ?? "";
      const tagsMatch = block.match(/tags:\s*\[([^\]]+)\]/)?.[1] ?? "";
      const tags = tagsMatch
        .split(",")
        .map((t) => t.trim().replace(/^"|"$/g, ""));
      const notes = block.match(/notes:\s*"([^"]+)"/)?.[1];

      if (question && expected_source) {
        entries.push({ question, expected_source, tags, notes });
      }
    } catch {
      // skip malformed entry
    }
  }

  return entries;
}

// ─── Runner ───────────────────────────────────────────────────────────────────

await preload();

const dataset = await loadDataset();
const filtered = filterTag
  ? dataset.filter((tc) => tc.tags.includes(filterTag))
  : dataset;

if (filtered.length === 0) {
  console.log(
    `No test cases found${filterTag ? ` with tag: ${filterTag}` : ""}`,
  );
  process.exit(0);
}

console.log(
  `\n🧪 Golden Dataset — ${filtered.length} test case(s)${filterTag ? ` [tag=${filterTag}]` : ""}\n`,
);

let passed = 0;
let failed = 0;
const testUser = `golden-${Date.now()}`;

for (let i = 0; i < filtered.length; i++) {
  const tc = filtered[i]!;
  process.stdout.write(
    `  [${i + 1}/${filtered.length}] ${tc.question.slice(0, 60)}... `,
  );

  try {
    const r = await runPipeline(testUser, tc.question);

    const actionOk = r.action === "respond";
    const citationOk = r.citations.some((c) => c.source === tc.expected_source);

    if (actionOk && citationOk) {
      console.log("✅");
      passed++;
    } else {
      console.log("❌");
      if (!actionOk)
        console.error(`     action=${r.action} (expected: respond)`);
      if (!citationOk) {
        const sources = r.citations.map((c) => c.source).join(", ") || "(none)";
        console.error(
          `     expected source: ${tc.expected_source} | got: ${sources}`,
        );
      }
      if (tc.notes) console.error(`     note: ${tc.notes}`);
      failed++;
    }
  } catch (err) {
    console.log("❌ THREW");
    console.error(`     ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

console.log(`\n${"─".repeat(50)}`);
console.log(
  `Results: ${passed} passed, ${failed} failed out of ${filtered.length}`,
);

if (failed > 0) {
  console.log(
    "\n⚠️  Failures indicate KB coverage gaps or triage precision issues.",
  );
  process.exit(1);
}
