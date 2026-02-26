import { join } from "path";

/**
 * Project root — override with PROJECT_ROOT env var so the process can be
 * started from any working directory (e.g. Docker entrypoints, PM2, etc.).
 */
const PROJECT_ROOT = process.env.PROJECT_ROOT ?? process.cwd();

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
    data: join(PROJECT_ROOT, "data"),
    chunks: join(PROJECT_ROOT, "data", "chunks"),
    guide: join(PROJECT_ROOT, "data", "guide.yaml"),
    manifest: join(PROJECT_ROOT, "source-manifest.json"),
    prompts: join(PROJECT_ROOT, "src", "prompts"),
    reports: join(PROJECT_ROOT, "data", "reports"),
    temp: {
      procedure: join(PROJECT_ROOT, "temp", "procedure"),
      qna: join(PROJECT_ROOT, "temp", "qna"),
      chat: join(PROJECT_ROOT, "temp", "chat"),
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

    // ── Retry backoff ─────────────────────────────────────────────────────────
    // Base delay in ms for the first retry. Each subsequent attempt doubles it.
    // e.g. attempt 0 → 1000ms, attempt 1 → 2000ms, attempt 2 → 4000ms
    retryBaseDelayMs: 1000,

    // Hard ceiling on the computed delay regardless of attempt number.
    retryMaxDelayMs: 30_000,

    // When true, adds ±20% random jitter to each sleep to prevent thundering
    // herd when multiple parallel extractions all hit rate-limits simultaneously.
    retryJitter: true,
  },

  // ─── HTTP Server ─────────────────────────────────────────────────────────────────────
  server: {
    // Allowed CORS origin — set CORS_ORIGIN env var in production.
    corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",

    // Maximum JSON body size accepted by /api/chat (bytes).
    // Default: 64 KB — a chat message larger than this is almost certainly an attack.
    maxBodyBytes: Number(process.env.MAX_BODY_BYTES ?? 65_536),

    // How long (ms) to wait for an LLM response before aborting the request.
    // Default: 120 s — generous enough for large documents, avoids hanging forever.
    requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS ?? 120_000),

    // — Rate limiting (sliding-window per session) ——————————————————
    // Time window in ms for the rate limit counter.
    rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000),
    // Maximum requests allowed per session within the window.
    rateLimitMaxRequests: Number(process.env.RATE_LIMIT_MAX ?? 20),

    // — Circuit breaker (LLM provider health) ————————————————————
    // Number of consecutive LLM failures before the breaker opens.
    circuitBreakerThreshold: Number(process.env.CIRCUIT_BREAKER_THRESHOLD ?? 5),
    // How long (ms) the breaker stays open before allowing a probe request.
    circuitBreakerResetMs: Number(
      process.env.CIRCUIT_BREAKER_RESET_MS ?? 60_000,
    ),
  },
};
