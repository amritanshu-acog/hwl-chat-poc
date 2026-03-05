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
