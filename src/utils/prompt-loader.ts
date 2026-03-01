import { readFile } from "fs/promises";
import { join } from "path";
import { CONFIG } from "../config.js";

const PROMPTS_DIR = CONFIG.paths.prompts;
const promptCache = new Map<string, string>();

/** Load a prompt .md file by name (without extension). Cached after first read. */
export async function loadPrompt(name: string): Promise<string> {
  const cached = promptCache.get(name);
  if (cached) return cached;
  const content = await readFile(join(PROMPTS_DIR, `${name}.md`), "utf-8");
  const trimmed = content.trim();
  promptCache.set(name, trimmed);
  return trimmed;
}
