import { readFile } from "fs/promises";
import { join } from "path";
import { CONFIG } from "../core/config.js";
import { logger } from "../core/logger.js";
import { parseGuideEntries } from "../utils/guide-parser.js";
import type { GuideEntry } from "../core/schemas.js";

// ─── Prompt Cache (static) ────────────────────────────────────────────────────
// Loaded at startup via preload(). Lives for the process lifetime.
// A process restart is required to pick up edited prompt files.

const promptCache = new Map<string, string>();

/**
 * Return a prompt file's contents by name (without .md extension).
 * Reads from disk on first access; cached statically thereafter.
 */
export async function getPrompt(name: string): Promise<string> {
  const cached = promptCache.get(name);
  if (cached !== undefined) return cached;

  const content = await readFile(
    join(CONFIG.paths.prompts, `${name}.md`),
    "utf-8",
  );
  const trimmed = content.trim();
  promptCache.set(name, trimmed);
  return trimmed;
}

// ─── Fallback Content Cache (static) ──────────────────────────────────────────
// default.md — the not-found response served to users.
// Static: only changes when the file is edited (process restart required).

let _fallback: string | null = null;

/**
 * Return the contents of default.md.
 * Cached statically (same lifetime as prompts).
 */
export async function getFallback(): Promise<string> {
  if (_fallback !== null) return _fallback;
  _fallback = await readFile(CONFIG.paths.fallback, "utf-8");
  return _fallback;
}

// ─── Guide Cache (TTL-based) ───────────────────────────────────────────────────
// guide.yaml is the only cache that refreshes at runtime.
// Re-reads from disk when the cached value is older than guideTtlSeconds.
// Setting guideTtlSeconds to 0 disables caching (always reads from disk).
// This lets run_compile and run_delete update the knowledge base without
// restarting the process.

interface GuideCache {
  entries: GuideEntry[];
  raw: string;
  loadedAt: number;
}

let _guide: GuideCache | null = null;

/**
 * Return the parsed guide.yaml entries and the raw YAML string.
 * Re-reads from disk if the cache is older than CONFIG.cache.guideTtlSeconds.
 *
 * GAP FIX #12: If the raw file is non-empty but parses to 0 entries,
 * log a warning (indicates a parse failure / corrupted file) and do NOT
 * cache the empty result — force a fresh read on the next request.
 */
export async function getGuide(): Promise<{
  entries: GuideEntry[];
  raw: string;
}> {
  const ttlMs = CONFIG.cache.guideTtlSeconds * 1000;
  const now = Date.now();

  if (_guide !== null && (ttlMs === 0 || now - _guide.loadedAt < ttlMs)) {
    return { entries: _guide.entries, raw: _guide.raw };
  }

  const raw = await readFile(CONFIG.paths.guide, "utf-8");
  const entries = parseGuideEntries(raw);

  // GAP FIX #12: guard against silent parse failure
  if (entries.length === 0 && raw.trim().length > 0) {
    logger.warn(
      "guide.yaml parsed to 0 entries but file is non-empty — possible parse failure or corrupted file. Not caching.",
      { rawBytes: raw.length },
    );
    // Return empty entries without caching so the next request retries the parse.
    return { entries: [], raw };
  }

  _guide = { entries, raw, loadedAt: now };

  logger.info("guide.yaml refreshed", { entryCount: entries.length });
  return { entries, raw };
}

/** Force-invalidate the guide cache (e.g. after a compile run). */
export function invalidateGuide(): void {
  _guide = null;
  logger.info("guide.yaml cache invalidated");
}

// ─── Preload ───────────────────────────────────────────────────────────────────
// Call once at process startup to warm all three caches before the first request.
// Failures are logged as warnings — the pipeline can still recover on first use.

export async function preload(): Promise<void> {
  const promptNames = Object.values(CONFIG.prompts);

  const results = await Promise.allSettled([
    // Warm every configured prompt.
    ...promptNames.map((name) => getPrompt(name)),

    // Warm the fallback content.
    getFallback(),

    // Warm the guide cache.
    getGuide(),
  ]);

  const failures = results
    .map((r, i) => (r.status === "rejected" ? { i, reason: r.reason } : null))
    .filter(Boolean);

  if (failures.length > 0) {
    logger.warn("Some resources failed to preload", { failures });
  } else {
    logger.info("Resources preloaded", {
      prompts: promptNames,
      fallback: CONFIG.paths.fallback,
      guide: CONFIG.paths.guide,
    });
  }
}
