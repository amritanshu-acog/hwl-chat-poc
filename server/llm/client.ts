import { CONFIG } from "../core/config.js";
import { logger } from "../core/logger.js";

// ─── Circuit Breaker ───────────────────────────────────────────────────────────
//
// CLOSED  — normal operation
// OPEN    — threshold failures hit; calls fail-fast
// HALF_OPEN — one probe after resetMs; success → CLOSED, fail → OPEN

type BreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

const breaker = { state: "CLOSED" as BreakerState, failures: 0, openedAt: 0 };

export function getBreakerState(): BreakerState {
  return breaker.state;
}

function breakerCall<T>(fn: () => Promise<T>): Promise<T> {
  const { circuitBreakerThreshold, circuitBreakerResetMs } = CONFIG.server;
  const now = Date.now();

  if (breaker.state === "OPEN") {
    if (now - breaker.openedAt >= circuitBreakerResetMs) {
      breaker.state = "HALF_OPEN";
      logger.warn("Circuit breaker: HALF_OPEN — sending probe request");
    } else {
      const remaining = Math.ceil(
        (circuitBreakerResetMs - (now - breaker.openedAt)) / 1000,
      );
      return Promise.reject(
        new Error(`Circuit breaker OPEN — retrying in ${remaining}s.`),
      );
    }
  }

  return fn().then(
    (result) => {
      if (breaker.state !== "CLOSED")
        logger.info("Circuit breaker: probe succeeded — CLOSED");
      breaker.failures = 0;
      breaker.state = "CLOSED";
      return result;
    },
    (err) => {
      breaker.failures++;
      if (
        breaker.state === "HALF_OPEN" ||
        breaker.failures >= circuitBreakerThreshold
      ) {
        breaker.state = "OPEN";
        breaker.openedAt = Date.now();
        logger.error(
          `Circuit breaker: OPEN after ${breaker.failures} failure(s). Retry in ${circuitBreakerResetMs / 1000}s.`,
        );
      }
      throw err;
    },
  );
}

/** Run fn() through the circuit breaker with one retry on transient errors. */
export async function callLlmWithRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await breakerCall(fn);
  } catch {
    await new Promise((r) => setTimeout(r, 2_000));
    return breakerCall(fn);
  }
}

// ─── JSON cleaner ──────────────────────────────────────────────────────────────
// Strips markdown fences and extracts the first complete JSON object/array
// from a raw LLM response string.

export function cleanJson(raw: string): string {
  let cleaned = raw
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  const firstBracket = cleaned.search(/[\[{]/);
  if (firstBracket === -1) return cleaned;
  cleaned = cleaned.slice(firstBracket);

  const openChar = cleaned[0];
  const closeChar = openChar === "[" ? "]" : "}";
  let depth = 0,
    endIndex = -1,
    inString = false,
    escapeNext = false;

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escapeNext = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === openChar) depth++;
    else if (ch === closeChar && --depth === 0) {
      endIndex = i;
      break;
    }
  }

  if (endIndex !== -1) cleaned = cleaned.slice(0, endIndex + 1).trim();
  return cleaned.replace(/,\s*}/g, "}").replace(/,\s*]/g, "]");
}

// ─── LLM Error Classification ──────────────────────────────────────────────────

export type LlmErrorType =
  | "rate_limit"
  | "auth"
  | "token_limit"
  | "transient"
  | "unknown";

export function classifyLlmError(err: unknown): LlmErrorType {
  const msg =
    err instanceof Error
      ? err.message.toLowerCase()
      : String(err).toLowerCase();
  const status: number | undefined =
    (err as any)?.status ?? (err as any)?.statusCode;

  if (
    status === 401 ||
    status === 403 ||
    msg.includes("api key") ||
    msg.includes("unauthorized") ||
    msg.includes("forbidden")
  )
    return "auth";
  if (
    status === 429 ||
    msg.includes("rate limit") ||
    msg.includes("too many requests") ||
    msg.includes("quota")
  )
    return "rate_limit";
  if (
    msg.includes("token") ||
    msg.includes("context length") ||
    msg.includes("maximum context") ||
    msg.includes("content too large") ||
    status === 413
  )
    return "token_limit";
  if (status !== undefined && status >= 500) return "transient";
  return "unknown";
}
