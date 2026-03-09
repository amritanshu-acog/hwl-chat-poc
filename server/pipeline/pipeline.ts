import { generateText } from "ai";
import { getModel } from "../llm/providers.js";
import { getPrompt, getGuide } from "../resources/resources.js";
import { CONFIG } from "../core/config.js";
import { logger } from "../core/logger.js";
import { callLlmWithRetry } from "../llm/client.js";
import { Session } from "../session/session.js";
import { runTriage } from "./triage.js";
import { runResponder } from "./responder.js";
import { runFormatter } from "./formatter.js";
import { getFallbackContent } from "./fallback.js";
import type { TurnResult, Citation } from "../core/schemas.js";
import type { ConversationTurn } from "../session/session.js";

// ─── Title generation ─────────────────────────────────────────────────────────

/**
 * Generate a short session title from the user's first message.
 * Called once — on the first turn of a new session — before LLM routing.
 * Degrades gracefully to a generic title if the LLM call fails.
 *
 * GAP FIX #1/#10: passes CONFIG.models.title to getModel().
 */
async function generateTitle(message: string): Promise<string> {
  try {
    const prompt = await getPrompt(CONFIG.prompts.title);
    const result = await callLlmWithRetry(() =>
      generateText({
        model: getModel(CONFIG.models.title),
        system: prompt,
        prompt: message,
        temperature: CONFIG.temperature.title,
      }),
    );
    return result.text.trim();
  } catch {
    return "Support conversation";
  }
}

// ─── Pipeline turn ────────────────────────────────────────────────────────────

/**
 * Process one user turn through the full retrieval pipeline.
 *
 * Turn lifecycle:
 *   1. Load or create session
 *   2. Quota check (no LLM calls if exceeded)
 *   3. Title generation (first turn of a new session only)
 *   4. Record user turn
 *   5. Load guide (TTL cache)
 *   6. Triage loop — with one optional new_topic window advance and re-run
 *   7. Route: clarify → formatter | respond → responder → formatter | not_found → fallback → formatter
 *   8. Record assistant turn (raw response — not formatted)
 *   9. Save session
 *  10. Log turn_end
 *
 * @param userId    User identifier — from JWT claim in HTTP mode, CLI arg in dev mode.
 * @param message   The user's message for this turn.
 * @param sessionId Optional — resume an existing session. Omit to start a new one.
 */
export async function runPipeline(
  userId: string,
  message: string,
  sessionId?: string,
): Promise<TurnResult> {
  const start = Date.now();

  // ── 1. Load or create session ──────────────────────────────────────────────

  const session = sessionId
    ? await Session.load(userId, sessionId)
    : Session.create(userId);

  // Short trace key for all log lines in this turn.
  const trace = {
    user: userId,
    session: session.session_id.slice(0, 8),
    window: session.window,
  };

  logger.info("turn_start", trace);

  // ── 2. Quota check — before any LLM calls ─────────────────────────────────

  if (session.isQuotaExceeded()) {
    const max = CONFIG.sessions.maxTurnsPerSession;
    logger.info("quota_exceeded", { ...trace, max_turns: max });

    return {
      session_id: session.session_id,
      action: "quota_exceeded",
      response: `You have reached the limit of ${max} turns for this session. Please start a new session to continue.`,
      response_type: "quota_exceeded",
      citations: [],
    };
  }

  // ── 3. Title generation (first turn only) ─────────────────────────────────
  // Check before recording the user turn so totalUserTurns() === 0 is reliable.

  if (session.totalUserTurns() === 0) {
    const title = await generateTitle(message);
    session.setTitle(title);
    logger.debug("session title set", { title });
  }

  // ── 4. Record user turn ───────────────────────────────────────────────────

  session.recordUserTurn(message);

  // ── 5. Load guide ─────────────────────────────────────────────────────────

  const guide = await getGuide();

  // ── 6. Triage loop ────────────────────────────────────────────────────────

  let windowTurns: ConversationTurn[] = session.currentWindowTurns();
  let triageResult = await runTriage(
    windowTurns,
    session.clarificationsUsed(),
    guide,
  );

  // Handle new_topic: advance window, re-run triage on the isolated message.
  // The re-run is always unconditional and never repeated — a single-message
  // window always resolves to clarify, respond, or not_found.
  if (triageResult.action === "new_topic") {
    logger.info("new_topic", {
      ...trace,
      prevWindow: session.window,
      nextWindow: session.window + 1,
    });

    session.bumpWindow();

    // Isolated single-message context for the re-run.
    windowTurns = [{ role: "user", content: message }];
    triageResult = await runTriage(windowTurns, 0, guide);
  }

  // Refresh trace with the final window number after any bump.
  const finalTrace = { ...trace, window: session.window };
  logger.info("triage", { ...finalTrace, action: triageResult.action });

  // ── 7. Route based on triage action ───────────────────────────────────────

  let rawResponse: string;
  let responseType: TurnResult["response_type"];
  let action: TurnResult["action"];
  let citations: Citation[] = [];
  let recordedChunkIds: string[] | undefined;

  switch (triageResult.action) {
    // ── Clarify ──────────────────────────────────────────────────────────────
    // Return a clarifying question. No window advance — the question stays in
    // the current topic window so the next user turn can still be matched.
    case "clarify": {
      rawResponse = triageResult.question;
      responseType = "clarify";
      action = "clarify";
      break;
    }

    // ── Respond ───────────────────────────────────────────────────────────────
    // Load chunks, call respond LLM, build citations.
    // If no chunk files are loadable, fall through to serve default.md instead.
    case "respond": {
      const respondResult = await runResponder(
        triageResult.chunk_ids,
        windowTurns,
        guide.entries,
      );

      if (!respondResult) {
        // All chunk files missing from final/ — fallback without a respond LLM call.
        rawResponse = await getFallbackContent();
        responseType = "notfound";
      } else {
        rawResponse = respondResult.respondOutput.response;
        responseType = respondResult.respondOutput.type;
        citations = respondResult.citations;
        recordedChunkIds = respondResult.loadedChunkIds;
      }

      action = "respond";
      session.resetWindow();
      break;
    }

    // ── Not found ─────────────────────────────────────────────────────────────
    // Question is clear but nothing in the index covers it.
    case "not_found": {
      rawResponse = await getFallbackContent();
      responseType = "notfound";
      action = "not_found";
      session.resetWindow();
      break;
    }

    // new_topic was handled above and re-run; this branch is unreachable.
    default: {
      rawResponse = await getFallbackContent();
      responseType = "notfound";
      action = "not_found";
      session.resetWindow();
    }
  }

  // ── Format response ────────────────────────────────────────────────────────
  // GAP FIX #2: pass responseType so the correct format prompt is selected.
  // The formatter shapes the raw text for presentation (markdown or MDX).
  // Formatting happens after routing so the same formatter handles all branches.

  const formatted = await runFormatter(rawResponse, responseType);

  // ── 8. Record assistant turn ───────────────────────────────────────────────
  // Raw response is stored in history — not the formatted output.
  // This keeps conversation context factual and free of presentation markup.

  session.recordAssistantTurn(rawResponse, {
    chunk_ids: recordedChunkIds,
    citations: citations.length > 0 ? citations : undefined,
    duration_ms: Date.now() - start,
  });

  // ── 9. Save session ────────────────────────────────────────────────────────

  await session.save();

  // ── 10. Log turn_end ───────────────────────────────────────────────────────

  logger.info("turn_end", {
    ...finalTrace,
    action,
    response_type: responseType,
    duration_ms: Date.now() - start,
    citations: citations.length,
    sources: [...new Set(citations.map((c) => c.source))],
  });

  return {
    session_id: session.session_id,
    action,
    response: formatted,
    response_type: responseType,
    citations,
  };
}
