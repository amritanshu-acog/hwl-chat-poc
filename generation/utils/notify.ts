/**
 * generation/utils/notify.ts
 *
 * Notification hook (stub).
 *
 * Called by the quality stage after each run. Currently a no-op that logs
 * what would be sent. Replace the body of notify() to wire in a real channel
 * (email, Slack, webhook) without changing any call sites.
 *
 * Design reference: §15 Developer Notes — "Design this as a stub so that
 * a channel-specific implementation can be wired in later without changing
 * the quality stage logic."
 */

import type { StageLogger } from "../core/logger.js";

// ─── Event types ──────────────────────────────────────────────────────────────
// Add new event shapes here as new stages need notifications.

export interface QualityCompletePayload {
  doc_type: "procedure" | "qna";
  timestamp: string;
  total_chunks: number;
  passed: number;
  failed: number;
}

export type NotifyEvent = {
  event: "quality_complete";
  payload: QualityCompletePayload;
};

// ─── Stub implementation ──────────────────────────────────────────────────────

/**
 * Send a notification for a pipeline event.
 *
 * Currently a no-op stub — swapping the body here is all that's needed
 * to go live with a real notification channel.
 */
export async function notify(ev: NotifyEvent, log: StageLogger): Promise<void> {
  // ── STUB ─────────────────────────────────────────────────────────────────
  // Replace everything below this line with a real implementation.
  // The function signature must remain the same.

  log.info("Notification hook (stub) — not yet wired to a channel", {
    event: ev.event,
    payload: ev.payload,
  });

  // Example future implementation:
  // await fetch(process.env.SLACK_WEBHOOK_URL!, {
  //   method: "POST",
  //   headers: { "Content-Type": "application/json" },
  //   body: JSON.stringify({
  //     text: `Quality complete for ${ev.payload.doc_type}: ` +
  //           `${ev.payload.passed}/${ev.payload.total_chunks} passed`,
  //   }),
  // });
}
