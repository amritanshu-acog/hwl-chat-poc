import { join } from "path";

/**
 * Ingestion pipeline configuration (Task 3: centralize configuration)
 */
export const CONFIG = {
  // ─── Document Segmentation (chunker.ts) ──────────────────────────────────────
  segmenter: {
    // Segments shorter than this merge with the next one
    minSegmentChars: 300,
    // Segments longer than this are candidates for sub-splitting
    maxSegmentChars: 8000,
  },

  // ─── Paths ───────────────────────────────────────────────────────────────────
  paths: {
    data: join(process.cwd(), "data"),
    chunks: join(process.cwd(), "data", "chunks"),
    guide: join(process.cwd(), "data", "guide.yaml"),
    manifest: join(process.cwd(), "source-manifest.json"),
    prompts: join(process.cwd(), "src", "prompts"),
    reports: join(process.cwd(), "data", "reports"),
  },

  // ─── Extraction settings ──────────────────────────────────────────────────────
  extraction: {
    // Minimum text length to attempt structural segmentation
    minTextLengthForSegmentation: 200,
  },
};
