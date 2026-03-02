/**
 * generation/utils/backoff.ts
 *
 * Rate-limit backoff with the fixed sequence defined in §14:
 *   5s → 10s → 20s → 40s → 60s → final attempt
 *
 * 6 total attempts. If all fail, the last error is re-thrown.
 *
 * Usage:
 *   const result = await withBackoff(() => callLlm(prompt), log);
 */

import type { StageLogger } from "../core/logger.js";

// ─── Backoff sequence ─────────────────────────────────────────────────────────
// Delays in ms between attempts. Index 0 = delay before attempt 2, etc.
// 6 attempts total: 1 initial + 5 retries.

const BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 60_000] as const;

// ─── Error classifier ─────────────────────────────────────────────────────────

function isRateLimitError(err: unknown): boolean {
  const msg =
    err instanceof Error
      ? err.message.toLowerCase()
      : String(err).toLowerCase();
  const status: number | undefined =
    (err as any)?.status ?? (err as any)?.statusCode;

  return (
    status === 429 ||
    msg.includes("rate limit") ||
    msg.includes("too many requests") ||
    msg.includes("quota") ||
    msg.includes("resource_exhausted")
  );
}

function isAuthError(err: unknown): boolean {
  const status: number | undefined =
    (err as any)?.status ?? (err as any)?.statusCode;
  const msg =
    err instanceof Error
      ? err.message.toLowerCase()
      : String(err).toLowerCase();

  return (
    status === 401 ||
    status === 403 ||
    msg.includes("api key") ||
    msg.includes("unauthorized") ||
    msg.includes("forbidden")
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * Run fn() with exponential backoff on rate-limit errors.
 *
 * Auth errors abort immediately (no retry — retrying won't fix a bad key).
 * Transient/unknown errors also get the full retry sequence.
 *
 * @param fn     Async function to retry
 * @param log    Stage logger (used to emit retry warnings)
 * @returns      Result of fn() on first success
 * @throws       Last error if all attempts fail
 */
export async function withBackoff<T>(
  fn: () => Promise<T>,
  log: StageLogger,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Auth errors: abort immediately — retrying won't help
      if (isAuthError(err)) {
        log.error("Auth error — aborting retries", {
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }

      // Last attempt exhausted
      if (attempt === BACKOFF_MS.length) {
        log.error(`All ${BACKOFF_MS.length + 1} attempt(s) failed`, {
          error: err instanceof Error ? err.message : String(err),
        });
        break;
      }

      const delayMs = BACKOFF_MS[attempt]!;
      const isRateLimit = isRateLimitError(err);

      log.warn(
        `${isRateLimit ? "Rate limit" : "Transient error"} — retrying in ${delayMs / 1000}s`,
        {
          attempt: attempt + 1,
          nextAttempt: attempt + 2,
          totalAttempts: BACKOFF_MS.length + 1,
          error: err instanceof Error ? err.message : String(err),
        },
      );

      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}
