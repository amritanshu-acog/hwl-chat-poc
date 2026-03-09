/**
 * @deprecated DEAD CODE — GAP FIX #7
 *
 * This file is NOT used by any pipeline code. The active prompt cache lives in
 * resources/resources.ts (getPrompt()). This file's fs.watch() fires correctly
 * but evicts entries from a local Map that nobody reads — prompt hot-reload
 * does NOT work via this file.
 *
 * Options:
 *   A) Delete this file. Document that prompt changes need a process restart.
 *   B) Wire hot-reload: replace the promptCache + getPrompt in resources.ts
 *      with this loadPrompt() export, which already has the watch logic.
 *
 * Until then this file is kept for reference only.
 */

import { readFile } from "fs/promises";
import { join } from "path";
import { watch } from "fs";
import { CONFIG } from "../core/config.js";
import { logger } from "../core/logger.js";

const PROMPTS_DIR = CONFIG.paths.prompts;
const promptCache = new Map<string, string>();

// Evict only the changed prompt file from cache — others remain warm.
try {
  watch(PROMPTS_DIR, (_, filename) => {
    if (!filename) return;
    const name = filename.replace(/\.md$/, "");
    if (promptCache.delete(name)) logger.info(`Prompt cache evicted: ${name}`);
  });
} catch {
  logger.warn(
    "Could not watch prompts directory — cache persists until restart",
  );
}

/** Load a prompt .md file by name (without extension). Cached after first read. */
export async function loadPrompt(name: string): Promise<string> {
  const cached = promptCache.get(name);
  if (cached) return cached;
  const content = await readFile(join(PROMPTS_DIR, `${name}.md`), "utf-8");
  const trimmed = content.trim();
  promptCache.set(name, trimmed);
  return trimmed;
}
