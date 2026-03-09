import { generateText } from "ai";
import { getModel } from "../llm/providers.js";
import { getPrompt } from "../resources/resources.js";
import { CONFIG } from "../core/config.js";
import { logger } from "../core/logger.js";
import { callLlmWithRetry } from "../llm/client.js";
import type { TurnResult } from "../core/schemas.js";

// ─── Prompt selection ─────────────────────────────────────────────────────────

/**
 * GAP FIX #2: Map response_type to the correct per-type format prompt key.
 *
 * Each response type has its own prompt file so formatting can be tuned
 * independently — e.g. options responses get a structured "choose one"
 * layout, notfound responses get a softer empathetic framing.
 */
function formatPromptKey(
  responseType: TurnResult["response_type"],
): keyof typeof CONFIG.prompts {
  switch (responseType) {
    case "answer":
      return "format_answer";
    case "options":
      return "format_options";
    case "mixed":
      return "format_mixed";
    case "clarify":
      return "format_clarify";
    case "notfound":
    case "quota_exceeded":
      return "format_notfound";
  }
}

// ─── Formatter ────────────────────────────────────────────────────────────────

/**
 * Call the format LLM to shape a raw response for presentation.
 *
 * GAP FIX #2: accepts responseType and loads the matching per-type prompt.
 * GAP FIX #1/#10: passes CONFIG.models.format to getModel().
 *
 * The formatter never changes content — it only shapes structure and presentation.
 * The raw (unformatted) text is what goes into session history; the formatted
 * output is what gets returned to the caller.
 *
 * If formatting fails, the raw response is returned unchanged so the caller
 * always receives something readable.
 */
export async function runFormatter(
  rawResponse: string,
  responseType: TurnResult["response_type"],
): Promise<string> {
  const promptKey = formatPromptKey(responseType);
  const promptName = CONFIG.prompts[promptKey];

  let systemPrompt: string;
  try {
    systemPrompt = await getPrompt(promptName);
  } catch (err) {
    logger.error("Failed to load format prompt — returning raw response", {
      promptKey,
      promptName,
      err,
    });
    return rawResponse;
  }

  const t0 = Date.now();

  try {
    // GAP FIX #1/#10: use the format-specific model.
    const result = await callLlmWithRetry(() =>
      generateText({
        model: getModel(CONFIG.models.format),
        system: systemPrompt,
        prompt: rawResponse,
        temperature: CONFIG.temperature.format,
      }),
    );

    logger.debug("formatter", {
      responseType,
      promptKey,
      durationMs: Date.now() - t0,
    });
    return result.text.trim();
  } catch (err) {
    logger.error("Formatter LLM call failed — returning raw response", {
      err,
      responseType,
      durationMs: Date.now() - t0,
    });
    // Degrade gracefully: unformatted content is better than no content.
    return rawResponse;
  }
}
