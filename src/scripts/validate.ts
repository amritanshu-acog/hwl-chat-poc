/**
 * bun run validate
 *
 * Reads all active chunks from data/chunks/, sends each to the LLM for
 * quality evaluation (Clarity, Consistency, Completeness), and marks
 * failing chunks as status: review in their front matter and guide.yaml.
 *
 * Run after extraction before going live.
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

async function main() {
  console.log("\n🔍 Validating chunks for quality gates...\n");
  console.log("Criteria: Clarity · Consistency · Completeness\n");

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

  // Only validate active chunks — skip review/deprecated
  const activeFiles = [];
  for (const file of files.sort()) {
    const raw = await readFile(join(CHUNKS_DIR, file), "utf-8");
    const status = getStatus(raw);
    if (status === "active") {
      activeFiles.push(file);
    } else {
      console.log(`  ⏭️  Skipping ${file} [${status}]`);
    }
  }

  console.log(`\n📂 Validating ${activeFiles.length} active chunk(s)...\n`);

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
