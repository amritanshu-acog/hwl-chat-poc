/**
 * generation/pipeline/archive.ts
 *
 * Archive stage — §2 Document Lifecycle.
 *
 * On full pipeline success, moves ONLY the specific input files that were
 * successfully chunked (≥ 1 chunk) to input/processed/<doc_type>/.
 * Files that failed or produced zero chunks remain in input/.
 *
 * Uses rename() (atomic on same filesystem) with a copy+delete fallback
 * for cross-device moves (e.g. input and processed on different mounts).
 */

import { rename, copyFile, unlink, mkdir } from "fs/promises";
import { join } from "path";
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
 * Archive a specific list of successfully-chunked input files.
 *
 * §2: Only files that produced ≥ 1 chunk are eligible for archiving.
 * Files that failed or were skipped at chunk stage remain in input/.
 *
 * @param doc_type         "procedure" or "qna"
 * @param filesToArchive   Exact filenames (not paths) that were successfully chunked
 * @param log              Stage logger
 * @returns                ArchiveResult with lists of archived and failed filenames
 */
export async function runArchive(
  doc_type: "procedure" | "qna",
  filesToArchive: string[],
  log: StageLogger,
): Promise<ArchiveResult> {
  const inputDir =
    doc_type === "procedure"
      ? CONFIG.directories.input_procedure
      : CONFIG.directories.input_qna;

  const processedDir = join(CONFIG.directories.processed, doc_type);

  log.info("Archive stage started", {
    doc_type,
    inputDir,
    processedDir,
    files: filesToArchive.length,
  });

  if (filesToArchive.length === 0) {
    log.info("No files to archive", { doc_type });
    return { doc_type, archived: [], failed: [] };
  }

  // Ensure the processed directory exists
  await mkdir(processedDir, { recursive: true });

  const archived: string[] = [];
  const failed: string[] = [];

  for (const filename of filesToArchive) {
    const src = join(inputDir, filename);
    const dest = join(processedDir, filename);

    try {
      await moveFile(src, dest);
      log.info("Archived file", { filename, dest });
      archived.push(filename);
    } catch (err) {
      log.error("Failed to archive file — leaving in input dir", {
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
