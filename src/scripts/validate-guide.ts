/**
 * src/scripts/validate-guide.ts  — GAP-D1-10
 *
 * CLI: bun run validate-guide
 *
 * Purpose:
 *   Zod-validates every entry in data/guide.yaml against GuideEntrySchema.
 *   This is a fast, pure structural check — no LLM calls.
 *   Run before serving to confirm the index is well-formed.
 *
 * Exit codes:
 *   0 — all entries pass
 *   1 — one or more entries fail schema validation
 */

import { readFile } from "fs/promises";
import { join } from "path";
import { GuideEntrySchema } from "../schemas.js";
import { ZodError } from "zod";
import { CONFIG } from "../config.js";

const GUIDE_PATH = CONFIG.paths.guide;

// ─── YAML block parser ────────────────────────────────────────────────────────
// guide.yaml is NOT a general YAML file — it follows a strict, known structure.
// We parse it with the same regex approach used by the rest of the codebase
// (rather than adding a YAML library dependency).

interface RawEntry {
  chunk_id: string;
  topic: string;
  summary: string;
  triggers: string[];
  has_conditions: boolean;

  related_chunks: string[];
  status: string;
}

function parseGuideBlock(block: string): RawEntry | null {
  const chunk_id = block.match(/^\s*([^\n]+)/)?.[1]?.trim() ?? "";
  const topic = block.match(/\n\s+topic:\s*(.+)/)?.[1]?.trim() ?? "";
  const source = block.match(/\n\s+source:\s*(.+)/)?.[1]?.trim() ?? "";
  const summary = block.match(/summary:\s*>\s*\n\s+(.+)/)?.[1]?.trim() ?? "";
  const has_conditions =
    block.match(/\n\s+has_conditions:\s*(true|false)/)?.[1] === "true";
  const rawStatus =
    block.match(/\n\s+status:\s*(\w+)/)?.[1]?.trim() ?? "active";

  const triggersSection = block.match(/\n\s+triggers:\s*\n((?:\s+- .+\n?)*)/);
  const triggers = triggersSection?.[1]
    ? [...triggersSection[1].matchAll(/- "?(.+?)"?\s*$/gm)].map((m) =>
        m[1]!.trim(),
      )
    : [];

  const relatedSection = block.match(
    /\n\s+related_chunks:\s*\n((?:\s+- .+\n?)*)/,
  );
  const related_chunks = relatedSection?.[1]
    ? [...relatedSection[1].matchAll(/- (.+?)\s*$/gm)].map((m) =>
        // Strip accidental "chunk_id:" prefixes (GAP-D1-05)
        m[1]!.trim().replace(/^chunk_id:/i, ""),
      )
    : [];

  if (!chunk_id) return null;

  return {
    chunk_id,
    topic,
    summary,
    triggers,
    has_conditions,
    related_chunks,
    status: rawStatus,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n🔍 Validating guide.yaml against GuideEntrySchema...\n");

  let raw: string;
  try {
    raw = await readFile(GUIDE_PATH, "utf-8");
  } catch {
    console.error(`❌ Could not read guide.yaml at: ${GUIDE_PATH}`);
    console.error("   Run bun run extract first.");
    process.exit(1);
  }

  // Split into blocks, one per chunk entry
  const blocks = raw
    .split(/^  - chunk_id:/m)
    .filter((b) => b.trim() && !b.trim().startsWith("#"));

  if (blocks.length === 0) {
    console.warn("⚠️  No entries found in guide.yaml.");
    process.exit(0);
  }

  console.log(`📂 Found ${blocks.length} guide.yaml entry/entries\n`);

  let passed = 0;
  let failed = 0;
  const errors: { chunk_id: string; issues: string[] }[] = [];

  for (const block of blocks) {
    const raw = parseGuideBlock(block);
    if (!raw) {
      console.warn("  ⚠️  Could not parse a block — skipping");
      continue;
    }

    try {
      GuideEntrySchema.parse(raw);
      console.log(`  ✅ ${raw.chunk_id}`);
      passed++;
    } catch (err) {
      failed++;
      const issues: string[] = [];
      if (err instanceof ZodError) {
        for (const issue of err.issues) {
          const field = issue.path.join(".") || "(root)";
          issues.push(`${field}: ${issue.message}`);
          console.log(`  ❌ ${raw.chunk_id}`);
          console.log(`       ${field}: ${issue.message}`);
        }
      } else {
        issues.push(String(err));
        console.log(`  ❌ ${raw.chunk_id}: unexpected error`);
      }
      errors.push({ chunk_id: raw.chunk_id, issues });
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(`\n📊 guide.yaml Validation Summary`);
  console.log(`   Entries checked: ${passed + failed}`);
  console.log(`   Passed:          ${passed}`);
  console.log(`   Failed:          ${failed}`);

  if (failed > 0) {
    console.log(`\n⚠️  ${failed} entry/entries failed schema validation.`);
    console.log("   Fix the issues above, then re-run: bun run validate-guide");
    process.exit(1);
  } else {
    console.log("\n✅ All guide.yaml entries are structurally valid.\n");
  }
}

main().catch((err) => {
  console.error("❌ validate-guide failed:", err);
  process.exit(1);
});
