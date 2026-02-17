import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Directory where prompt .md files are stored */
const PROMPTS_DIR = join(__dirname, "prompts");

/** Cache loaded prompts in memory to avoid repeated file reads */
const promptCache = new Map<string, string>();

/**
 * Load a prompt from a .md file in the prompts directory.
 *
 * @param name - The filename (without .md extension) of the prompt to load
 * @returns The prompt content as a string
 *
 * @example
 * ```ts
 * const systemPrompt = await loadPrompt("extraction");
 * const chatPrompt = await loadPrompt("chat");
 * ```
 */
export async function loadPrompt(name: string): Promise<string> {
  const cached = promptCache.get(name);
  if (cached) return cached;

  const filePath = join(PROMPTS_DIR, `${name}.md`);
  const content = await readFile(filePath, "utf-8");
  const trimmed = content.trim();

  promptCache.set(name, trimmed);
  return trimmed;
}

/**
 * Clear the prompt cache (useful for development / hot-reload scenarios).
 */
export function clearPromptCache(): void {
  promptCache.clear();
}
