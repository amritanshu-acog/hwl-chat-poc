import { generateText } from "ai";
import { getModel } from "../llm/providers.js";
import { getPrompt } from "../resources/resources.js";
import { CONFIG } from "../core/config.js";
import { logger } from "../core/logger.js";
import { callLlmWithRetry } from "../llm/client.js";
import { cleanJson } from "../llm/client.js";
import { TriageOutputSchema } from "../core/schemas.js";
import type { TriageOutput, GuideEntry } from "../core/schemas.js";
import type { ConversationTurn } from "../session/session.js";

// ─── Message construction ─────────────────────────────────────────────────────

/**
 * Build the structured user message sent to the triage LLM.
 *
 * Layout:
 *   [Clarifications used in this window: X of Y]
 *
 *   KNOWLEDGE BASE INDEX:
 *   <raw guide.yaml content>
 *
 *   CONVERSATION WINDOW:
 *   user: ...
 *   assistant: ...
 *   user: <latest message>
 *
 * The clarification header is parsed by the prompt to enforce the clarify limit.
 * The knowledge base index is the raw YAML so the LLM sees topics, summaries,
 * and triggers exactly as they appear in guide.yaml.
 */
function buildTriageMessage(
  guideRaw: string,
  windowTurns: ConversationTurn[],
  clarificationsUsed: number,
  clarificationLimit: number,
): string {
  const clarHeader = `[Clarifications used in this window: ${clarificationsUsed} of ${clarificationLimit}]`;

  const windowText =
    windowTurns.length > 0
      ? windowTurns.map((t) => `${t.role}: ${t.content}`).join("\n")
      : "(no prior turns in this window)";

  return [
    clarHeader,
    "",
    "KNOWLEDGE BASE INDEX:",
    guideRaw,
    "",
    "CONVERSATION WINDOW:",
    windowText,
  ].join("\n");
}

// ─── Triage ───────────────────────────────────────────────────────────────────

/**
 * Call the triage LLM and return one of four routing actions.
 *
 * GAP FIX #1/#10: passes CONFIG.models.triage to getModel() so the correct
 * per-stage model is used — falls back to provider default when not set.
 *
 * @param windowTurns   All turns in the current window, including the user's
 *                      latest message. For a new_topic re-run this will be a
 *                      single-element array with just the new message.
 * @param clarificationsUsed  Number of assistant clarification turns already
 *                            issued in this window — injected into the prompt
 *                            so the LLM can enforce the configured limit.
 * @param guide         Parsed guide entries + raw YAML string.
 */
export async function runTriage(
  windowTurns: ConversationTurn[],
  clarificationsUsed: number,
  guide: { entries: GuideEntry[]; raw: string },
): Promise<TriageOutput> {
  const systemPrompt = await getPrompt(CONFIG.prompts.triage);

  const userMessage = buildTriageMessage(
    guide.raw,
    windowTurns,
    clarificationsUsed,
    CONFIG.retrieval.clarificationLimit,
  );

  const t0 = Date.now();

  // GAP FIX #1/#10: use the triage-specific model.
  const result = await callLlmWithRetry(() =>
    generateText({
      model: getModel(CONFIG.models.triage),
      system: systemPrompt,
      prompt: userMessage,
      temperature: CONFIG.temperature.triage,
    }),
  );

  logger.debug("triage raw output", {
    durationMs: Date.now() - t0,
    preview: result.text.slice(0, 300),
  });

  const parsed = TriageOutputSchema.parse(JSON.parse(cleanJson(result.text)));
  return parsed;
}
