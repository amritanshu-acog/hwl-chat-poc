/**
 * src/scripts/ingest.ts  — GAP-D1-02
 *
 * End-to-end ingestion orchestrator.
 *
 * Runs: extract → validate → relate → rebuild in the correct sequence
 * with full error propagation, per-step timing, and a structured final report.
 *
 * Usage:
 *   bun run ingest <file.pdf>
 *   bun run ingest ./docs/
 *   bun run ingest a.pdf b.pdf c.pdf
 */

import { execFileSync } from "child_process";
import { resolve, extname, basename } from "path";
import { stat, readdir, readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { CONFIG } from "../config.js";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface StepResult {
  step: string;
  success: boolean;
  durationMs: number;
  output: string;
  error?: string;
}

interface IngestReport {
  startedAt: string;
  sources: string[];
  steps: StepResult[];
  chunksInKB: number;
  totalDurationMs: number;
  success: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function banner(text: string): void {
  const line = "━".repeat(60);
  console.log(`\n${line}`);
  console.log(`  ${text}`);
  console.log(`${line}\n`);
}

function stepHeader(step: string, index: number, total: number): void {
  console.log(`\n[${index}/${total}] ${step}`);
  console.log("─".repeat(50));
}

/**
 * Run a bun script synchronously.
 * Uses execFileSync (NOT execSync) so args are passed as an array —
 * this avoids shell-splitting paths that contain spaces.
 */
function runStep(label: string, command: string, args: string[]): StepResult {
  const start = Date.now();
  let error: string | undefined;
  let success = false;

  try {
    execFileSync(command, args, {
      cwd: process.cwd(),
      encoding: "utf-8",
      // inherit: output streams directly to terminal so user sees progress live
      stdio: "inherit",
    });
    success = true;
  } catch (err: any) {
    // execFileSync throws on non-zero exit — extract the error message
    error = err?.message ?? String(err);
    success = false;
  }

  return {
    step: label,
    success,
    durationMs: Date.now() - start,
    output: "", // stdio:inherit means output went directly to terminal
    error,
  };
}

/** Count active chunks in guide.yaml */
async function countActiveChunks(): Promise<number> {
  try {
    const guide = await readFile(CONFIG.paths.guide, "utf-8");
    return (guide.match(/status:\s*active/g) ?? []).length;
  } catch {
    return 0;
  }
}

/** Resolve PDF sources from CLI args (files or directories) */
async function resolveSources(args: string[]): Promise<string[]> {
  const sources: string[] = [];
  for (const arg of args) {
    const resolved = resolve(arg);
    let info;
    try {
      info = await stat(resolved);
    } catch {
      console.warn(`⚠️  Path not found: ${arg}`);
      continue;
    }

    if (info.isDirectory()) {
      const entries = await readdir(resolved);
      const pdfs = entries
        .filter((f) => extname(f).toLowerCase() === ".pdf")
        .sort()
        .map((f) => join(resolved, f));

      if (pdfs.length === 0) {
        console.warn(`⚠️  No PDFs found in: ${resolved}`);
      }
      sources.push(...pdfs);
    } else if (info.isFile()) {
      if (extname(resolved).toLowerCase() !== ".pdf") {
        console.warn(`⚠️  Skipping non-PDF: ${arg}`);
      } else {
        sources.push(resolved);
      }
    }
  }
  return sources;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(`
Usage:
  bun run ingest [--type=qna] <source> [source2] ...

Sources & Flags:
  • --type=qna               Use specialized Q&A extraction prompt for FAQ docs
  • Single PDF file:         bun run ingest ./manual.pdf
  • Multiple PDFs:           bun run ingest a.pdf b.pdf
  • Whole directory:         bun run ingest ./docs/
  • Mixed:                   bun run ingest --type=qna ./docs/ extra.pdf

What this does (in order):
  1. extract  — PDF → chunk .md files + guide.yaml
  2. validate — LLM quality gates (Clarity, Consistency, Completeness)
  3. relate   — Populate related_chunks across all active chunks
  4. rebuild  — Regenerate guide.yaml from chunk front matter (source of truth)
`);
    process.exit(1);
  }

  banner("🚀 HWL Knowledge Base — Ingestion Orchestrator");

  const paths = args.filter((a) => !a.startsWith("--"));
  const flags = args.filter((a) => a.startsWith("--"));

  const sources = await resolveSources(paths);
  if (sources.length === 0) {
    console.error("❌ No valid PDF sources found. Aborting.");
    process.exit(1);
  }

  console.log("📋 Sources queued for ingestion:");
  sources.forEach((s) => console.log(`   • ${basename(s)}`));
  console.log(`\n   Total: ${sources.length} PDF(s)\n`);

  const startedAt = new Date().toISOString();
  const totalStart = Date.now();
  const steps: StepResult[] = [];

  // ── Step 1: Extract ─────────────────────────────────────────────────────────
  stepHeader("Extract — PDF → chunks + guide.yaml", 1, 4);
  const extractResult = runStep("extract", "bun", [
    "run",
    "extract",
    ...flags,
    ...sources,
  ]);
  steps.push(extractResult);

  if (!extractResult.success) {
    console.error("❌ Extraction failed:\n", extractResult.error);
    console.error(
      "\n⛔ Aborting pipeline — no point validating failed extraction.",
    );
    printReport({
      startedAt,
      sources,
      steps,
      chunksInKB: 0,
      totalDurationMs: Date.now() - totalStart,
      success: false,
    });
    process.exit(1);
  }
  console.log(`✅ Extract complete (${extractResult.durationMs}ms)`);

  // ── Step 2: Validate ────────────────────────────────────────────────────────
  stepHeader("Validate — Zod structural + LLM quality gates", 2, 4);
  const validateResult = runStep("validate", "bun", ["run", "validate"]);
  steps.push(validateResult);

  if (!validateResult.success) {
    console.warn(
      "⚠️  Validation step encountered errors:\n",
      validateResult.error,
    );
    console.warn(
      "   Continuing pipeline — failed chunks are marked 'review' and excluded from retrieval.",
    );
  } else {
    console.log(`✅ Validate complete (${validateResult.durationMs}ms)`);
  }

  // ── Step 3: Relate ──────────────────────────────────────────────────────────
  stepHeader("Relate — populate related_chunks across KB", 3, 4);
  const relateResult = runStep("relate", "bun", ["run", "relate"]);
  steps.push(relateResult);

  if (!relateResult.success) {
    console.warn("⚠️  Relate step failed:\n", relateResult.error);
    console.warn("   Continuing — related_chunks may be empty for new chunks.");
  } else {
    console.log(`✅ Relate complete (${relateResult.durationMs}ms)`);
  }

  // ── Step 4: Rebuild ─────────────────────────────────────────────────────────
  stepHeader("Rebuild — regenerate guide.yaml from chunk front matter", 4, 4);
  const rebuildResult = runStep("rebuild", "bun", ["run", "rebuild"]);
  steps.push(rebuildResult);

  if (!rebuildResult.success) {
    console.error("❌ Rebuild failed:\n", rebuildResult.error);
    // Rebuild failure is critical — guide.yaml may be stale
    printReport({
      startedAt,
      sources,
      steps,
      chunksInKB: 0,
      totalDurationMs: Date.now() - totalStart,
      success: false,
    });
    process.exit(1);
  }
  console.log(`✅ Rebuild complete (${rebuildResult.durationMs}ms)`);

  // ── Final report ────────────────────────────────────────────────────────────
  const chunksInKB = await countActiveChunks();
  const report: IngestReport = {
    startedAt,
    sources,
    steps,
    chunksInKB,
    totalDurationMs: Date.now() - totalStart,
    success: steps.every((s) => s.success),
  };

  printReport(report);

  // ── Save structured report (Task 15: Error reporting hook) ──────────────────
  try {
    const reportsDir = CONFIG.paths.reports;
    await mkdir(reportsDir, { recursive: true });
    const timestamp = startedAt.replace(/[:.]/g, "-");
    const reportPath = join(reportsDir, `ingest-${timestamp}.json`);
    await writeFile(reportPath, JSON.stringify(report, null, 2), "utf-8");
    console.log(`📝 Structured report saved: ${reportPath}`);
  } catch (err) {
    console.error("⚠️  Failed to save structured report:", err);
  }

  process.exit(report.success ? 0 : 1);
}

// ─── Report printer ───────────────────────────────────────────────────────────

function printReport(report: IngestReport): void {
  banner(
    report.success
      ? "✅ Ingestion Complete"
      : "⚠️  Ingestion Completed with Errors",
  );

  console.log(`  Started at:    ${report.startedAt}`);
  console.log(
    `  Total time:    ${(report.totalDurationMs / 1000).toFixed(1)}s`,
  );
  console.log(`  Sources:       ${report.sources.length} PDF(s)`);
  console.log(`  Active chunks: ${report.chunksInKB}`);
  console.log("");

  console.log("  Step Results:");
  const maxLabel = Math.max(...report.steps.map((s) => s.step.length));
  for (const step of report.steps) {
    const icon = step.success ? "✅" : "❌";
    const pad = " ".repeat(maxLabel - step.step.length);
    console.log(
      `    ${icon} ${step.step}${pad}  ${(step.durationMs / 1000).toFixed(1)}s`,
    );
    if (!step.success && step.error) {
      const preview = step.error.trim().split("\n")[0];
      console.log(`         └─ ${preview}`);
    }
  }

  console.log("");
  if (report.success) {
    console.log("  Knowledge base is ready. Start the server with:");
    console.log("    bun run server");
  } else {
    console.log("  Review errors above. Fix failing chunks, then re-run:");
    console.log("    bun run ingest <sources>");
  }
  console.log("");
}

main().catch((err) => {
  console.error("❌ Orchestrator failed:", err);
  process.exit(1);
});
