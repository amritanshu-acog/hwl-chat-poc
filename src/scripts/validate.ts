/**
 * bun run validate
 *
 * TWO-PHASE VALIDATION (GAP-D1-04):
 *
 * Phase 1 — Zod Structural Check (fast, no LLM):
 *   Parses YAML front matter from each .md file and validates it against
 *   ChunkFrontMatterSchema. Also checks that required markdown sections
 *   (Context, Response, Escalation) are present.
 *   Structurally invalid chunks are marked status:review immediately.
 *   No LLM call is wasted on broken chunks.
 *
 * Phase 2 — LLM Quality Gates (Clarity, Consistency, Completeness):
 *   Only structurally valid, active chunks proceed to the LLM quality check.
 *
 * Run after extraction before going live.
 */

import { readFile, writeFile, readdir } from "fs/promises";
import { join } from "path";
import { generateText } from "ai";
import { getModel } from "../providers.js";
import { cleanJson } from "../llm-client.js";
import { execSync } from "child_process";
import { ChunkFrontMatterSchema } from "../schemas.js";
import { ZodError } from "zod";
import { CONFIG } from "../config.js";

const CHUNKS_DIR = CONFIG.paths.chunks;

// ─── Model ─────────────────────────────────────────────────────────────────────

let _model: ReturnType<typeof getModel> | null = null;
function model() {
  if (!_model) _model = getModel();
  return _model;
}

// ─── Validator ─────────────────────────────────────────────────────────────────

interface ValidationResult {
  passed: boolean;
  clarity: { pass: boolean; reason: string };
  consistency: { pass: boolean; reason: string };
  completeness: { pass: boolean; reason: string };
}

async function validateChunk(
  chunkId: string,
  content: string,
): Promise<ValidationResult> {
  const prompt = `You are a knowledge base quality reviewer. Evaluate this helpdesk chunk.

CHUNK:
${content}

Only FAIL a criterion if there is a genuine blocker — meaning a customer cannot complete the process:
- CLARITY: Fail only if the topic is fundamentally ambiguous or steps directly contradict each other in a way that causes confusion.
- CONSISTENCY: Fail only if there are factual contradictions between sections (e.g. a step says do X, another says do not do X, or a referenced step number does not exist).
- COMPLETENESS: Fail only if a required step is entirely missing — not if it could be more detailed.

Do NOT fail for: wordiness, style preferences, could-be-clearer phrasing, or steps that are brief but accurate.

Return ONLY this JSON:
{
  "passed": true | false,
  "clarity": { "pass": true | false, "reason": "one sentence" },
  "consistency": { "pass": true | false, "reason": "one sentence" },
  "completeness": { "pass": true | false, "reason": "one sentence" }
}`;

  const { text } = await generateText({
    model: model(),
    prompt,
  });

  try {
    const cleaned = cleanJson(text);
    return JSON.parse(cleaned) as ValidationResult;
  } catch {
    console.warn(`  ⚠️  Could not parse validation response for ${chunkId}`);
    // Fail safe — mark for review if we can't parse
    return {
      passed: false,
      clarity: {
        pass: false,
        reason: "Could not parse LLM validation response",
      },
      consistency: { pass: true, reason: "" },
      completeness: { pass: true, reason: "" },
    };
  }
}

// ─── Front matter status updater ───────────────────────────────────────────────

function updateStatus(raw: string, newStatus: "active" | "review"): string {
  return raw.replace(
    /^status:\s*(active|review|deprecated)$/m,
    `status: ${newStatus}`,
  );
}

function getStatus(raw: string): string {
  return raw.match(/^status:\s*(\w+)$/m)?.[1]?.trim() ?? "active";
}

// ─── Main ──────────────────────────────────────────────────────────────────────

// ─── Structural validator ─────────────────────────────────────────────────────

interface StructuralResult {
  passed: boolean;
  issues: string[];
}

/**
 * Phase 1: Pure Zod check — no LLM.
 * Parses YAML front matter and validates required markdown sections.
 */
function validateStructure(raw: string, fileName: string): StructuralResult {
  const issues: string[] = [];

  // ── Extract YAML front matter ──────────────────────────────────────────────
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    return {
      passed: false,
      issues: ["No YAML front matter block found (missing --- delimiters)"],
    };
  }

  const fm = fmMatch[1]!;

  // Parse individual fields from front matter
  const chunk_id = fm.match(/^chunk_id:\s*(.+)$/m)?.[1]?.trim() ?? "";
  const topic = fm.match(/^topic:\s*(.+)$/m)?.[1]?.trim() ?? "";
  const summary = fm.match(/^summary:\s*>\s*\n\s+(.+)$/m)?.[1]?.trim() ?? "";
  const has_conditions =
    fm.match(/^has_conditions:\s*(true|false)$/m)?.[1] === "true";
  const escalationRaw =
    fm.match(/^escalation:\s*(.+)$/m)?.[1]?.trim() ?? "null";
  const escalation =
    escalationRaw === "null" ? null : escalationRaw.replace(/^"|"$/g, "");
  const rawStatus = fm.match(/^status:\s*(\w+)$/m)?.[1]?.trim() ?? "active";

  const triggersSection = fm.match(/^triggers:\s*\n((?:\s+- .+\n?)*)/m);
  const triggers = triggersSection?.[1]
    ? [...triggersSection[1].matchAll(/- "?(.+?)"?\s*$/gm)].map((m) =>
        m[1]!.trim(),
      )
    : [];

  const relatedSection = fm.match(/^related_chunks:\s*\n((?:\s+- .+\n?)*)/m);
  const related_chunks = relatedSection?.[1]
    ? [...relatedSection[1].matchAll(/- (.+?)\s*$/gm)].map((m) =>
        // Normalize: strip accidental 'chunk_id:' prefixes (GAP-D1-05)
        m[1]!.trim().replace(/^chunk_id:/i, ""),
      )
    : [];

  // ── Run Zod schema validation ───────────────────────────────────────────────
  try {
    ChunkFrontMatterSchema.parse({
      chunk_id,
      topic,
      summary,
      triggers,
      has_conditions,
      escalation,
      related_chunks,
      status: rawStatus,
    });
  } catch (err) {
    if (err instanceof ZodError) {
      for (const issue of err.issues) {
        const field = issue.path.join(".") || "(root)";
        issues.push(`front-matter.${field}: ${issue.message}`);
      }
    } else {
      issues.push(`Unexpected Zod error: ${String(err)}`);
    }
  }

  // ── Check required markdown sections ──────────────────────────────────────
  const requiredSections = ["## Context", "## Response", "## Escalation"];
  for (const section of requiredSections) {
    if (!raw.includes(section)) {
      issues.push(`Missing required markdown section: "${section}"`);
    }
  }

  // has_conditions:true requires a ## Conditions section
  if (has_conditions && !raw.includes("## Conditions")) {
    issues.push(
      `has_conditions is true but "## Conditions" section is missing`,
    );
  }

  return { passed: issues.length === 0, issues };
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(
    "\n🔍 Validating chunks (Phase 1: Structural · Phase 2: LLM Quality)...\n",
  );
  console.log(
    "Phase 1 — Zod structural check: front-matter schema + required sections",
  );
  console.log(
    "Phase 2 — LLM quality gates:    Clarity · Consistency · Completeness\n",
  );

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

  // ── Phase 1: Structural validation (Zod, no LLM) ─────────────────────────
  console.log(
    "\n━━━ Phase 1: Structural Validation ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n",
  );

  let structuralPassed = 0;
  let structuralFailed = 0;
  const activeFiles: string[] = [];

  for (const file of files.sort()) {
    const filePath = join(CHUNKS_DIR, file);
    const raw = await readFile(filePath, "utf-8");
    const status = getStatus(raw);

    if (status !== "active") {
      console.log(`  ⏭️  Skipping ${file} [${status}]`);
      continue;
    }

    const structural = validateStructure(raw, file);

    if (structural.passed) {
      console.log(`  ✅ ${file} — structure OK`);
      structuralPassed++;
      activeFiles.push(file);
    } else {
      console.log(`  ❌ ${file} — structural FAIL`);
      for (const issue of structural.issues) {
        console.log(`       • ${issue}`);
      }
      // Mark as review immediately — don't waste LLM call
      const updated = updateStatus(raw, "review");
      await writeFile(filePath, updated, "utf-8");
      console.log(`       → Marked as status: review (structural failure)`);
      structuralFailed++;
    }
  }

  console.log(
    `\n  Structural: ${structuralPassed} passed, ${structuralFailed} failed`,
  );

  if (structuralFailed > 0) {
    console.log(
      `  ⚠️  Rebuilding guide.yaml to reflect structural failures...`,
    );
    try {
      execSync("bun run rebuild", { stdio: "inherit" });
    } catch {
      console.error("  ❌ Guide rebuild failed. Run bun run rebuild manually.");
    }
  }

  // ── Phase 2: LLM quality check (only structurally valid, active chunks) ───
  console.log(
    "\n━━━ Phase 2: LLM Quality Gates ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n",
  );
  console.log(
    `📂 Sending ${activeFiles.length} structurally valid active chunk(s) to LLM...\n`,
  );

  let passed = 0;
  let failed = 0;

  for (const file of activeFiles) {
    const filePath = join(CHUNKS_DIR, file);
    const raw = await readFile(filePath, "utf-8");
    const chunkId = file.replace(".md", "");

    process.stdout.write(`  Checking ${chunkId}... `);

    const result = await validateChunk(chunkId, raw);

    if (result.passed) {
      console.log("✅ PASS");
      passed++;
    } else {
      console.log("❌ FAIL");
      failed++;

      // Log which criteria failed
      if (!result.clarity.pass) {
        console.log(`     Clarity:      ${result.clarity.reason}`);
      }
      if (!result.consistency.pass) {
        console.log(`     Consistency:  ${result.consistency.reason}`);
      }
      if (!result.completeness.pass) {
        console.log(`     Completeness: ${result.completeness.reason}`);
      }

      // Mark chunk as review
      const updated = updateStatus(raw, "review");
      await writeFile(filePath, updated, "utf-8");
      console.log(`     → Marked as status: review`);
    }
  }

  console.log(`\n📊 Validation complete`);
  console.log(`   Passed: ${passed}`);
  console.log(`   Failed: ${failed}`);

  if (failed > 0) {
    console.log(`\n⚠️  ${failed} chunk(s) marked as status: review`);
    console.log(`   These will be excluded from retrieval until fixed.`);
    console.log(`   Review them in data/chunks/, fix the content, then run:`);
    console.log(`   bun run validate\n`);

    // Rebuild guide to reflect status changes
    console.log("🔨 Rebuilding guide.yaml to reflect status changes...\n");
    try {
      execSync("bun run rebuild", { stdio: "inherit" });
    } catch {
      console.error("❌ Guide rebuild failed. Run bun run rebuild manually.");
    }
  } else {
    console.log(`\n✅ All chunks passed. Knowledge base is clean.\n`);
  }
}

main().catch((err) => {
  console.error("❌ Validation failed:", err);
  process.exit(1);
});
