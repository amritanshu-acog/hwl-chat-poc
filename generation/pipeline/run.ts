/**
 * generation/pipeline/run.ts
 *
 * Pipeline Orchestrator — §3 of the design spec.
 *
 * Runs four stages in sequence for both doc types:
 *   chunk → quality → compile → archive
 *
 * Each doc type is independent — failure of one does not block the other.
 *
 * Usage:
 *   bun generation/pipeline/run.ts
 *   bun generation/pipeline/run.ts --doc-type=procedure
 *   bun generation/pipeline/run.ts --doc-type=qna
 */

import { makeLogger } from "../core/logger.js";
import { runChunk } from "./chunk.js";
import { runQuality } from "./quality.js";
import { runCompile } from "./compile.js";
import { runArchive } from "./archive.js";

// ─── Types ────────────────────────────────────────────────────────────────────

type DocType = "procedure" | "qna";

interface DocTypeResult {
  doc_type: DocType;
  chunk: {
    success: boolean;
    processed: number;
    skipped: number;
    chunks_written: number;
  };
  quality: { success: boolean; passed: number; failed: number } | null;
  archive: { success: boolean; archived: number; failed: number } | null;
}

interface RunResult {
  success: boolean;
  compile: { success: boolean; totalFinal: number } | null;
  procedure: DocTypeResult;
  qna: DocTypeResult;
  totalDurationMs: number;
}

// ─── Per-doc-type pipeline ────────────────────────────────────────────────────

async function runForDocType(
  doc_type: DocType,
  log: ReturnType<typeof makeLogger>,
): Promise<{
  chunkResult: DocTypeResult["chunk"];
  qualityResult: DocTypeResult["quality"];
  priorSuccess: boolean;
}> {
  // ── Stage 1: Chunk ───────────────────────────────────────────────────────
  log.info(`[${doc_type}] Starting chunk stage`);
  let chunkResult: DocTypeResult["chunk"];

  try {
    const r = await runChunk(doc_type);
    chunkResult = {
      success: true,
      processed: r.processed.length,
      skipped: r.skipped.length,
      chunks_written: r.chunks_written,
    };
    log.info(`[${doc_type}] Chunk stage complete`, chunkResult);
  } catch (err) {
    // Fundamental failure (missing prompt, unreadable input dir)
    const error = err instanceof Error ? err.message : String(err);
    log.error(`[${doc_type}] Chunk stage fundamental failure`, { error });
    chunkResult = {
      success: false,
      processed: 0,
      skipped: 0,
      chunks_written: 0,
    };
    return { chunkResult, qualityResult: null, priorSuccess: false };
  }

  // If no chunks were written, skip quality (not an error per §3)
  if (chunkResult.chunks_written === 0) {
    log.info(`[${doc_type}] No chunks produced — skipping quality stage`);
    return { chunkResult, qualityResult: null, priorSuccess: true };
  }

  // ── Stage 2: Quality ─────────────────────────────────────────────────────
  log.info(`[${doc_type}] Starting quality stage`);
  let qualityResult: DocTypeResult["quality"] = null;

  try {
    const r = await runQuality(doc_type);
    qualityResult = { success: true, passed: r.passed, failed: r.failed };
    log.info(`[${doc_type}] Quality stage complete`, qualityResult);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error(`[${doc_type}] Quality stage failed`, { error });
    qualityResult = { success: false, passed: 0, failed: 0 };
    return { chunkResult, qualityResult, priorSuccess: false };
  }

  const priorSuccess = chunkResult.success && (qualityResult?.success ?? true);
  return { chunkResult, qualityResult, priorSuccess };
}

// ─── Main orchestrator ────────────────────────────────────────────────────────

async function run(docTypes: DocType[]): Promise<RunResult> {
  const log = makeLogger("orchestrator");
  const startMs = Date.now();

  log.info("Pipeline started", { doc_types: docTypes });

  const results: Record<DocType, DocTypeResult> = {
    procedure: {
      doc_type: "procedure",
      chunk: { success: false, processed: 0, skipped: 0, chunks_written: 0 },
      quality: null,
      archive: null,
    },
    qna: {
      doc_type: "qna",
      chunk: { success: false, processed: 0, skipped: 0, chunks_written: 0 },
      quality: null,
      archive: null,
    },
  };

  const priorSuccessMap: Record<DocType, boolean> = {
    procedure: false,
    qna: false,
  };

  // ── Run chunk + quality for each doc type (independent) ──────────────────
  for (const doc_type of docTypes) {
    const { chunkResult, qualityResult, priorSuccess } = await runForDocType(
      doc_type,
      log,
    );
    results[doc_type].chunk = chunkResult;
    results[doc_type].quality = qualityResult;
    priorSuccessMap[doc_type] = priorSuccess;
  }

  // ── Stage 3: Compile (once, across both doc types) ───────────────────────
  log.info("Starting compile stage");
  let compileResult: RunResult["compile"] = null;

  try {
    const r = await runCompile();
    compileResult = { success: r.success, totalFinal: r.totalFinal };
    log.info("Compile stage complete", compileResult);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error("Compile stage failed", { error });
    compileResult = { success: false, totalFinal: 0 };
  }

  // ── Stage 4: Archive (per doc type, only if prior stages succeeded) ───────
  for (const doc_type of docTypes) {
    if (!priorSuccessMap[doc_type] || !compileResult?.success) {
      log.warn(`[${doc_type}] Skipping archive — prior stage(s) failed`);
      continue;
    }

    log.info(`[${doc_type}] Starting archive stage`);
    try {
      const r = await runArchive(doc_type, log);
      results[doc_type].archive = {
        success: r.failed.length === 0,
        archived: r.archived.length,
        failed: r.failed.length,
      };
      log.info(
        `[${doc_type}] Archive stage complete`,
        results[doc_type].archive,
      );
    } catch (err) {
      log.error(`[${doc_type}] Archive stage failed`, { error: String(err) });
      results[doc_type].archive = { success: false, archived: 0, failed: 0 };
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const totalDurationMs = Date.now() - startMs;
  const overallSuccess =
    (compileResult?.success ?? false) &&
    docTypes.every((dt) => results[dt].chunk.success);

  log.info("Pipeline complete", {
    success: overallSuccess,
    totalDurationMs,
    compile: compileResult,
    procedure: results.procedure,
    qna: results.qna,
  });

  printSummary(
    results,
    compileResult,
    docTypes,
    totalDurationMs,
    overallSuccess,
  );

  return {
    success: overallSuccess,
    compile: compileResult,
    procedure: results.procedure,
    qna: results.qna,
    totalDurationMs,
  };
}

// ─── Summary printer ──────────────────────────────────────────────────────────

function printSummary(
  results: Record<DocType, DocTypeResult>,
  compileResult: RunResult["compile"],
  docTypes: DocType[],
  totalDurationMs: number,
  success: boolean,
): void {
  const log = makeLogger("orchestrator");

  console.log("\n" + "═".repeat(60));
  console.log(
    success ? "✅  PIPELINE COMPLETE" : "❌  PIPELINE COMPLETED WITH ERRORS",
  );
  console.log("═".repeat(60));
  console.log(`Total time: ${(totalDurationMs / 1000).toFixed(1)}s\n`);

  for (const doc_type of docTypes) {
    const r = results[doc_type];
    console.log(`── ${doc_type.toUpperCase()} ──`);
    const c = r.chunk;
    console.log(
      `  Chunk:   ${c.success ? "✅" : "❌"}  processed=${c.processed} skipped=${c.skipped} written=${c.chunks_written}`,
    );
    if (r.quality) {
      const q = r.quality;
      console.log(
        `  Quality: ${q.success ? "✅" : "❌"}  passed=${q.passed} failed=${q.failed}`,
      );
    } else {
      console.log(`  Quality: ⏭  skipped`);
    }
    if (r.archive) {
      const a = r.archive;
      console.log(
        `  Archive: ${a.success ? "✅" : "❌"}  archived=${a.archived} failed=${a.failed}`,
      );
    } else {
      console.log(`  Archive: ⏭  skipped`);
    }
    console.log("");
  }

  if (compileResult) {
    console.log(`── COMPILE ──`);
    console.log(
      `  ${compileResult.success ? "✅" : "❌"}  total_final=${compileResult.totalFinal}`,
    );
  }

  console.log("═".repeat(60) + "\n");
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);

  // Parse --doc-type=procedure or --doc-type=qna
  let docTypes: DocType[] = ["procedure", "qna"];
  for (const arg of args) {
    const match = arg.match(/^--doc-type=(procedure|qna)$/);
    if (match) {
      docTypes = [match[1] as DocType];
    }
  }

  const result = await run(docTypes);
  process.exit(result.success ? 0 : 1);
}
