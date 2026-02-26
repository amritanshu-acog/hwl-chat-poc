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
    temp: {
      procedure: join(process.cwd(), "temp", "procedure"),
      qna: join(process.cwd(), "temp", "qna"),
      chat: join(process.cwd(), "temp", "chat"),
    },
  },

  // ─── Extraction settings ──────────────────────────────────────────────────────
  extraction: {
    // Minimum text length to attempt structural segmentation
    minTextLengthForSegmentation: 200,

    // Maximum tokens to request from the LLM during chunk extraction.
    // A single-shot extraction over a multi-section PDF can produce very long
    // JSON arrays; without an explicit ceiling the provider often truncates the
    // response mid-array, yielding a JSON parse error.  16 000 covers even
    // large documents while staying within gpt-4o's 16 384-token output limit.
    maxOutputTokens: 16000,

    // How many times to retry a failed extraction before giving up
    llmRetries: 2,
  },
};
