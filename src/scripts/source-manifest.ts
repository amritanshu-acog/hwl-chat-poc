/**
 * src/scripts/source-manifest.ts  — GAP-D1-14 / GAP-D1-17
 *
 * Source provenance tracker.
 *
 * Writes and reads source-manifest.json which maps each ingested PDF
 * to the chunk_ids it produced, along with a content hash and timestamp.
 *
 * This solves two problems:
 *   1. GAP-D1-14: Duplicate detection — before re-extracting a PDF, delete
 *      all chunks from the previous extraction run via the manifest.
 *   2. GAP-D1-17: Provenance tracking — you can always answer "which PDF
 *      produced this chunk?" without reading chunk content.
 *
 * Used by:
 *   - src/extract.ts    (writes after each successful extraction)
 *   - src/scripts/ingest.ts  (reads to display provenance in report)
 */

import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { createHash } from "crypto";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface ManifestEntry {
  /** SHA256 hash of the PDF file content — used for change detection */
  hash: string;
  /** ISO timestamp of last successful extraction */
  extracted_at: string;
  /** Chunk IDs produced from this source PDF */
  chunk_ids: string[];
  /** Human-readable size */
  size_bytes: number;
}

export type SourceManifest = Record<string, ManifestEntry>;

// ─── Paths ────────────────────────────────────────────────────────────────────

const MANIFEST_PATH = join(process.cwd(), "source-manifest.json");

// ─── I/O ──────────────────────────────────────────────────────────────────────

/**
 * Load source-manifest.json, returning an empty object if it doesn't exist.
 */
export async function loadManifest(): Promise<SourceManifest> {
  try {
    const raw = await readFile(MANIFEST_PATH, "utf-8");
    return JSON.parse(raw) as SourceManifest;
  } catch {
    return {};
  }
}

/**
 * Save source-manifest.json.
 */
export async function saveManifest(manifest: SourceManifest): Promise<void> {
  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2), "utf-8");
}

// ─── Hash helpers ─────────────────────────────────────────────────────────────

/**
 * Compute a SHA256 hash of a Buffer (PDF content).
 * Used to detect whether a PDF has changed since last extraction.
 */
export function hashBuffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

// ─── Manifest operations ──────────────────────────────────────────────────────

/**
 * Check if the given PDF (identified by file path and current hash) has
 * already been extracted and hasn't changed since.
 *
 * @returns true if PDF is in manifest AND hash matches (no re-extraction needed)
 */
export function isUnchanged(
  manifest: SourceManifest,
  sourcePath: string,
  currentHash: string,
): boolean {
  const entry = manifest[sourcePath];
  return !!entry && entry.hash === currentHash;
}

/**
 * Record a successful extraction in the manifest.
 * Un-registers any previous chunk_ids for this source (prevents stale references).
 */
export function recordExtraction(
  manifest: SourceManifest,
  sourcePath: string,
  hash: string,
  sizeBytes: number,
  chunkIds: string[],
): void {
  manifest[sourcePath] = {
    hash,
    extracted_at: new Date().toISOString(),
    chunk_ids: chunkIds,
    size_bytes: sizeBytes,
  };
}

/**
 * Get all chunk_ids that were produced from a given source PDF.
 * Returns empty array if source not in manifest.
 */
export function getChunkIdsForSource(
  manifest: SourceManifest,
  sourcePath: string,
): string[] {
  return manifest[sourcePath]?.chunk_ids ?? [];
}

/**
 * Find which source PDF produced a given chunk_id.
 * Returns undefined if not tracked.
 */
export function findSourceForChunk(
  manifest: SourceManifest,
  chunkId: string,
): string | undefined {
  for (const [source, entry] of Object.entries(manifest)) {
    if (entry.chunk_ids.includes(chunkId)) return source;
  }
  return undefined;
}

/**
 * Print a formatted summary of the manifest.
 */
export function printManifestSummary(manifest: SourceManifest): void {
  const entries = Object.entries(manifest);
  if (entries.length === 0) {
    console.log("  (no entries in source-manifest.json)");
    return;
  }

  for (const [source, entry] of entries) {
    const name = source.split("/").pop() ?? source;
    const kb = (entry.size_bytes / 1024).toFixed(1);
    console.log(`  📄 ${name}`);
    console.log(`       Chunks:    ${entry.chunk_ids.length}`);
    console.log(`       Extracted: ${entry.extracted_at}`);
    console.log(`       Size:      ${kb} KB`);
    console.log(`       Hash:      ${entry.hash.substring(0, 16)}...`);
  }
}
