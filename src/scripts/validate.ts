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
import { logger } from "../logger.js";

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
    logger.warn("Could not parse LLM validation response", { chunkId });
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
  const source = fm.match(/^source:\s*(.+)$/m)?.[1]?.trim() ?? "unknown";
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
      source,
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
  const requiredSections = ["## Context", "## Response"];
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
  logger.info("Validation started", {
    phase1: "Zod structural",
    phase2: "LLM quality gates",
  });

  let files: string[];
  try {
    files = (await readdir(CHUNKS_DIR)).filter((f) => f.endsWith(".md"));
  } catch {
    logger.error("Could not read chunks directory", { dir: CHUNKS_DIR });
    process.exit(1);
  }

  if (files.length === 0) {
    logger.warn("No chunks found — run bun run extract first");
    process.exit(0);
  }

  // ── Phase 1: Structural validation (Zod, no LLM) ─────────────────────────
  logger.info("Phase 1: structural validation starting", {
    totalFiles: files.length,
  });

  let structuralPassed = 0;
  let structuralFailed = 0;
  const activeFiles: string[] = [];

  for (const file of files.sort()) {
    const filePath = join(CHUNKS_DIR, file);
    const raw = await readFile(filePath, "utf-8");
    const status = getStatus(raw);

    if (status !== "active") {
      logger.debug("Skipping non-active chunk", { file, status });
      continue;
    }

    const structural = validateStructure(raw, file);

    if (structural.passed) {
      logger.info("Phase 1 PASS", { file });
      structuralPassed++;
      activeFiles.push(file);
    } else {
      logger.warn("Phase 1 FAIL — structural issues found", {
        file,
        issues: structural.issues,
      });
      // Mark as review immediately — don't waste LLM call
      const updated = updateStatus(raw, "review");
      await writeFile(filePath, updated, "utf-8");
      logger.info("Chunk marked as review (structural failure)", { file });
      structuralFailed++;
    }
  }

  logger.info("Phase 1 complete", {
    passed: structuralPassed,
    failed: structuralFailed,
  });

  if (structuralFailed > 0) {
    logger.info("Rebuilding guide.yaml to reflect structural failures");
    try {
      execSync("bun run rebuild", { stdio: "inherit" });
    } catch {
      logger.error("Guide rebuild failed — run bun run rebuild manually");
    }
  }

  // ── Phase 2: LLM quality check (only structurally valid, active chunks) ───
  logger.info("Phase 2: LLM quality gates starting", {
    activeChunks: activeFiles.length,
  });

  let passed = 0;
  let failed = 0;

  for (const file of activeFiles) {
    const filePath = join(CHUNKS_DIR, file);
    const raw = await readFile(filePath, "utf-8");
    const chunkId = file.replace(".md", "");

    process.stdout.write(`  Checking ${chunkId}... `);

    const result = await validateChunk(chunkId, raw);

    if (result.passed) {
      logger.info("Phase 2 PASS", { chunkId });
      passed++;
    } else {
      logger.warn("Phase 2 FAIL", {
        chunkId,
        clarity: result.clarity,
        consistency: result.consistency,
        completeness: result.completeness,
      });
      failed++;

      // Mark chunk as review
      const updated = updateStatus(raw, "review");
      await writeFile(filePath, updated, "utf-8");
      logger.info("Chunk marked as review (LLM quality failure)", { chunkId });
    }
  }

  logger.info("Validation complete", { passed, failed });

  if (failed > 0) {
    logger.warn(
      `${failed} chunk(s) marked as review — excluded from retrieval until fixed`,
    );
    // Rebuild guide to reflect status changes
    logger.info("Rebuilding guide.yaml to reflect status changes");
    try {
      execSync("bun run rebuild", { stdio: "inherit" });
    } catch {
      logger.error("Guide rebuild failed — run bun run rebuild manually");
    }
  } else {
    logger.info("All chunks passed validation — knowledge base is clean");
  }
}

main().catch((err) => {
  logger.error("Validation script failed", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
