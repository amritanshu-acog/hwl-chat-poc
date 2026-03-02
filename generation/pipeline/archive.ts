/**
 * generation/pipeline/archive.ts
 *
 * Archive stage — §2 Document Lifecycle.
 *
 * On full pipeline success, moves input PDFs to input/processed/<doc_type>/.
 * Runs per doc_type, only when all prior stages succeeded for that doc_type.
 *
 * Uses rename() (atomic on same filesystem) with a copy+delete fallback
 * for cross-device moves (e.g. input and processed on different mounts).
 */

import { rename, copyFile, unlink, readdir } from "fs/promises";
import { join, basename } from "path";
import { CONFIG } from "../core/config.js";
import type { StageLogger } from "../core/logger.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ArchiveResult {
  doc_type: "procedure" | "qna";
  archived: string[]; // filenames successfully moved
  failed: string[]; // filenames that failed to move
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Move a file, falling back to copy+delete if rename() fails with EXDEV
 * (source and destination on different filesystems).
 */
async function moveFile(src: string, dest: string): Promise<void> {
  try {
    await rename(src, dest);
  } catch (err: any) {
    if (err?.code === "EXDEV") {
      // Cross-device: copy then delete
      await copyFile(src, dest);
      await unlink(src);
    } else {
      throw err;
    }
  }
}

// ─── Stage ────────────────────────────────────────────────────────────────────

/**
 * Archive all PDFs in an input directory to the corresponding processed directory.
 *
 * @param doc_type  "procedure" or "qna"
 * @param log       Stage logger
 * @returns         ArchiveResult with lists of archived and failed filenames
 */
export async function runArchive(
  doc_type: "procedure" | "qna",
  log: StageLogger,
): Promise<ArchiveResult> {
  const inputDir =
    doc_type === "procedure"
      ? CONFIG.directories.input_procedure
      : CONFIG.directories.input_qna;

  const processedDir = join(CONFIG.directories.processed, doc_type);

  log.info("Archive stage started", { doc_type, inputDir, processedDir });

  // ── List PDFs in input dir ────────────────────────────────────────────────
  let allFiles: string[];
  try {
    allFiles = await readdir(inputDir);
  } catch (err) {
    log.error("Cannot read input directory — skipping archive", {
      doc_type,
      inputDir,
      error: err instanceof Error ? err.message : String(err),
    });
    return { doc_type, archived: [], failed: [] };
  }

  const pdfs = allFiles.filter((f) => f.toLowerCase().endsWith(".pdf"));

  if (pdfs.length === 0) {
    log.info("No PDFs to archive", { doc_type });
    return { doc_type, archived: [], failed: [] };
  }

  log.info("PDFs found for archiving", { doc_type, count: pdfs.length });

  const archived: string[] = [];
  const failed: string[] = [];

  // ── Move each PDF ─────────────────────────────────────────────────────────
  for (const filename of pdfs) {
    const src = join(inputDir, filename);
    const dest = join(processedDir, filename);

    try {
      await moveFile(src, dest);
      log.info("Archived PDF", { filename, dest });
      archived.push(filename);
    } catch (err) {
      log.error("Failed to archive PDF — leaving in input dir", {
        filename,
        error: err instanceof Error ? err.message : String(err),
      });
      failed.push(filename);
    }
  }

  log.info("Archive stage complete", {
    doc_type,
    archived: archived.length,
    failed: failed.length,
  });

  return { doc_type, archived, failed };
}
