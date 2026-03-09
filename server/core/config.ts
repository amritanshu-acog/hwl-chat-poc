import { join } from "path";

/**
 * Project root — override with PROJECT_ROOT env var so the process can be
 * started from any working directory (e.g. Docker entrypoints, PM2, etc.).
 */
const PROJECT_ROOT = process.env.PROJECT_ROOT ?? process.cwd();

export const CONFIG = {
  // ─── Paths ───────────────────────────────────────────────────────────────────
  paths: {
    // Directory containing guide.yaml, <uuid>.md chunk files, and default.md.
    // Owned exclusively by the generation pipeline — never written to by retrieval.
    chunks: join(PROJECT_ROOT, "generation", "output", "final"),
    guide: join(PROJECT_ROOT, "generation", "output", "final", "guide.yaml"),
    fallback: join(PROJECT_ROOT, "generation", "output", "final", "default.md"),
    prompts: join(PROJECT_ROOT, "server", "prompts"),
  },

  // ─── Prompts ─────────────────────────────────────────────────────────────────
  // Names of prompt .md files (without extension) read from CONFIG.paths.prompts.
  prompts: {
    triage: process.env.PROMPT_TRIAGE ?? "triage",
    respond: process.env.PROMPT_RESPOND ?? "respond",
    title: process.env.PROMPT_TITLE ?? "title",

    // GAP FIX #2: per-response-type format prompts.
    // Swap individual prompt names via env vars for deployment-specific overrides
    // (e.g. PROMPT_FORMAT_ANSWER=format-mdx-answer for an MDX deployment).
    format_answer: process.env.PROMPT_FORMAT_ANSWER ?? "format-answer",
    format_options: process.env.PROMPT_FORMAT_OPTIONS ?? "format-options",
    format_mixed: process.env.PROMPT_FORMAT_MIXED ?? "format-mixed",
    format_clarify: process.env.PROMPT_FORMAT_CLARIFY ?? "format-clarify",
    format_notfound: process.env.PROMPT_FORMAT_NOTFOUND ?? "format-notfound",
  },

  // ─── Models ──────────────────────────────────────────────────────────────────
  // Per-call model overrides. When unset (undefined), the provider's default
  // model is used. Override at the call level via env vars:
  //   MODEL_TRIAGE=gpt-4o-mini MODEL_RESPOND=gpt-4o bun run serve
  models: {
    triage: process.env.MODEL_TRIAGE,
    respond: process.env.MODEL_RESPOND,
    format: process.env.MODEL_FORMAT,
    title: process.env.MODEL_TITLE,
  },

  // ─── Temperature ─────────────────────────────────────────────────────────────
  // 0 = deterministic (recommended for triage and respond).
  temperature: {
    triage: Number(process.env.TEMP_TRIAGE ?? 0),
    respond: Number(process.env.TEMP_RESPOND ?? 0),
    format: Number(process.env.TEMP_FORMAT ?? 0),
    title: Number(process.env.TEMP_TITLE ?? 0),
  },

  // ─── Retrieval ────────────────────────────────────────────────────────────────
  retrieval: {
    // Max clarifying questions per topic window before triage must resolve.
    clarificationLimit: Number(process.env.CLARIFICATION_LIMIT ?? 2),
  },

  // ─── Sessions ─────────────────────────────────────────────────────────────────
  sessions: {
    // Root directory for JSONL session files, organised as <dir>/<user_id>/<file>.jsonl
    dir: process.env.SESSIONS_DIR ?? join(PROJECT_ROOT, "data", "sessions"),

    // Total user turns allowed per session before quota_exceeded is returned.
    // This is a per-session cap, not a rate limit — see §10 of the design.
    maxTurnsPerSession: Number(process.env.MAX_TURNS_PER_SESSION ?? 20),
  },

  // ─── Cache ────────────────────────────────────────────────────────────────────
  cache: {
    // Seconds before guide.yaml is re-read from disk. 0 = always read from disk.
    // Allows the knowledge base to be updated without a process restart.
    guideTtlSeconds: Number(process.env.GUIDE_TTL_SECONDS ?? 300),
  },

  // ─── Logging ─────────────────────────────────────────────────────────────────
  logging: {
    logDir: process.env.LOG_DIR ?? join(PROJECT_ROOT, "logs"),
  },

  // ─── Auth ─────────────────────────────────────────────────────────────────────
  // HTTP API only. The JWT secret (HS256) or public key / JWKS URL (RS256) is
  // set via environment variable — never stored here.
  auth: {
    // "HS256" for shared secret, "RS256" for public key / JWKS.
    jwtAlgorithm: (process.env.JWT_ALGORITHM ?? "HS256") as "HS256" | "RS256",

    // JWT claim extracted as user_id for session storage.
    userIdClaim: process.env.JWT_USER_ID_CLAIM ?? "sub",
  },

  // ─── HTTP Server ──────────────────────────────────────────────────────────────
  server: {
    // Allowed CORS origin — set CORS_ORIGIN env var in production.
    corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",

    // Maximum JSON body size accepted (bytes). Default: 64 KB.
    maxBodyBytes: Number(process.env.MAX_BODY_BYTES ?? 65_536),

    // How long (ms) to wait for a pipeline response before aborting.
    requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS ?? 120_000),

    // ── Circuit breaker (LLM provider health) ────────────────────────────────
    circuitBreakerThreshold: Number(process.env.CIRCUIT_BREAKER_THRESHOLD ?? 5),
    circuitBreakerResetMs: Number(
      process.env.CIRCUIT_BREAKER_RESET_MS ?? 60_000,
    ),
  },
};
