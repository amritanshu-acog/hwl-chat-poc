import { Hono } from "hono";
import { cors } from "hono/cors";
import { readFile, appendFile, mkdir } from "fs/promises";
import { join, basename } from "path";
import { answerTroubleshootingQuestion } from "./llm-client.js";
import { CONFIG } from "./config.js";
import { runWithRequestId } from "./logger.js";

// ─── Types ──────────────────────────────────────────────────────────────────────

type Message = { role: "user" | "assistant"; content: string };
type Session = { messages: Message[]; lastAccess: number };
type Mode = "clarify" | "answer";

// ─── App & state ────────────────────────────────────────────────────────────────

const app = new Hono();
const sessions = new Map<string, Session>();

const SESSION_MAX_MESSAGES = 20;
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

// ─── Log setup ─────────────────────────────────────────────────────────────────

const LOG_DIR = join(process.cwd(), "data", "logs");
const LOG_PATH = join(LOG_DIR, "requests.ndjson");
await mkdir(LOG_DIR, { recursive: true });

interface LogEntry {
  reqId: string;
  timestamp: string;
  sessionId: string;
  mode: Mode;
  question: string;
  responseEnvelope: unknown;
  durationMs: number;
}

/**
 * Fire-and-forget log write — never delays the HTTP response.
 * Errors are swallowed (logged to stderr); log failures must not affect clients.
 */
function writeLog(entry: LogEntry): void {
  appendFile(LOG_PATH, JSON.stringify(entry) + "\n", "utf-8").catch((err) => {
    console.error("[logger] Failed to write log entry:", err);
  });
}

// ─── CORS ───────────────────────────────────────────────────────────────────────
// Origin is driven by CONFIG.server.corsOrigin (set CORS_ORIGIN env var in prod)

app.use(
  "/api/*",
  cors({
    origin: CONFIG.server.corsOrigin,
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  }),
);

// ─── Rate limiter (sliding-window, per-session) ────────────────────────────────
//
// Tracks request timestamps for each session in a rolling window.
// No external dependency — purely in-memory, sufficient for single-instance POC.
// In multi-instance production: swap for Redis + a sliding-log implementation.

const rateLimitStore = new Map<string, number[]>();

function isRateLimited(sessionId: string): boolean {
  const now = Date.now();
  const windowMs = CONFIG.server.rateLimitWindowMs;
  const maxRequests = CONFIG.server.rateLimitMaxRequests;

  const timestamps = (rateLimitStore.get(sessionId) ?? []).filter(
    (t) => now - t < windowMs,
  );

  if (timestamps.length >= maxRequests) {
    rateLimitStore.set(sessionId, timestamps);
    return true;
  }

  timestamps.push(now);
  rateLimitStore.set(sessionId, timestamps);
  return false;
}

// ─── Startup ──────────────────────────────────────────────────────────────────

const GUIDE_PATH = join(process.cwd(), "data", "guide.yaml");
let chunkCount = 0;

try {
  const guide = await readFile(GUIDE_PATH, "utf-8");
  const guideBlocks = guide.split(/^\s{2}- chunk_id:/m).filter((b) => b.trim());
  chunkCount = guideBlocks.filter((b) => b.match(/status:\s*active/)).length;
  console.log(`\n🚀 Server ready — ${chunkCount} chunks in guide.yaml\n`);
} catch {
  console.warn("⚠️  guide.yaml not found. Run bun run extract first.");
}
console.log("🌐 Listening on http://localhost:3000");
console.log(`📝 Logging to ${LOG_PATH}\n`);
console.log(`🔒 CORS origin: ${CONFIG.server.corsOrigin}`);
console.log(`⏱  Request timeout: ${CONFIG.server.requestTimeoutMs / 1000}s`);
console.log(
  `🚦 Rate limit: ${CONFIG.server.rateLimitMaxRequests} req / ${CONFIG.server.rateLimitWindowMs / 1000}s per session\n`,
);

// ─── Load Manifest Map ────────────────────────────────────────────────────────

const manifestMap = new Map<string, string>();
try {
  const manifestData = JSON.parse(
    await readFile(join(process.cwd(), "source-manifest.json"), "utf-8"),
  );
  for (const [pdfPath, info] of Object.entries(manifestData)) {
    const pdfName = basename(pdfPath);
    for (const chunk_id of (info as any).chunk_ids) {
      manifestMap.set(chunk_id, pdfName);
    }
  }
} catch {
  console.warn(
    "⚠️  source-manifest.json not found. Source file mappings may not be available.",
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getSession(sessionId: string): Session {
  const now = Date.now();
  let session = sessions.get(sessionId);

  if (!session || now - session.lastAccess > SESSION_TTL_MS) {
    session = { messages: [], lastAccess: now };
    sessions.set(sessionId, session);
    return session;
  }

  session.lastAccess = now;
  return session;
}

function pruneStale() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastAccess > SESSION_TTL_MS) sessions.delete(id);
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// Health check
app.get("/api/health", (c) => {
  return c.json({ status: "ok", chunksLoaded: chunkCount });
});

// List all chunks from guide.yaml
app.get("/api/chunks", async (c) => {
  try {
    const guide = await readFile(GUIDE_PATH, "utf-8");
    const chunks: Array<{
      chunk_id: string;
      topic: string;
      summary: string;
      status: string;
    }> = [];

    const blocks = guide
      .split(/^\s{2}- chunk_id:/m)
      .filter((b) => b.trim() && !b.trim().startsWith("#"));

    for (const block of blocks) {
      const chunk_id = block.match(/^\s*([^\n]+)/)?.[1]?.trim() ?? "";
      const topic = block.match(/\n\s+topic:\s*(.+)/)?.[1]?.trim() ?? "";
      const summary =
        block.match(/summary:\s*>\s*\n\s+(.+)/)?.[1]?.trim() ?? "";
      const status =
        block.match(/\n\s+status:\s*(\w+)/)?.[1]?.trim() ?? "active";

      if (chunk_id && topic) {
        chunks.push({ chunk_id, topic, summary, status });
      }
    }

    return c.json({ chunks, count: chunks.length });
  } catch (err) {
    console.error("[/api/chunks] Error:", err);
    return c.json({ error: "Failed to read guide.yaml" }, 500);
  }
});

/**
 * POST /api/chat
 *
 * Request body: { message: string, sessionId: string, mode?: "clarify" | "answer" }
 *
 * Response: JSON envelope the frontend uses to render MDX components.
 * Single response:  { type, data }
 * Multiple responses: [{ type, data }, { type, data }, ...]
 */
app.post("/api/chat", async (c) => {
  const startTime = Date.now();
  // Short random ID to correlate all logs for this single request
  const reqId = Math.random().toString(36).slice(2, 10);

  return runWithRequestId(reqId, async () => {
    try {
      // ── Body size guard ───────────────────────────────────────────────────
      const contentLength = Number(c.req.header("content-length") ?? 0);
      if (contentLength > CONFIG.server.maxBodyBytes) {
        return c.json({ error: "Request body too large" }, 413);
      }

      const body = await c.req.json();
      const {
        message,
        sessionId,
        mode = "answer",
      } = body as {
        message: string;
        sessionId: string;
        mode?: Mode;
      };

      if (!message || !sessionId) {
        return c.json(
          { error: "Both 'message' and 'sessionId' are required" },
          400,
        );
      }

      // ── Rate limit guard ───────────────────────────────────────────────────────
      if (isRateLimited(sessionId)) {
        return c.json(
          {
            error:
              "Too many requests. Please wait before sending another message.",
            retryAfterMs: CONFIG.server.rateLimitWindowMs,
          },
          429,
        );
      }

      pruneStale();
      const session = getSession(sessionId);

      // ── Request timeout ────────────────────────────────────────────────────────
      // Race the LLM pipeline against an AbortSignal-driven timeout.
      // When the timeout fires, the response is sent immediately and the
      // in-flight LLM call is abandoned (the provider connection is dropped).
      const timeoutMs = CONFIG.server.requestTimeoutMs;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      let raw: string;
      let parsed: unknown;
      let contextChunks: Awaited<
        ReturnType<typeof answerTroubleshootingQuestion>
      >["contextChunks"];

      try {
        const result = await Promise.race([
          answerTroubleshootingQuestion(message, session.messages, mode),
          new Promise<never>((_, reject) =>
            controller.signal.addEventListener("abort", () =>
              reject(new Error("Request timed out")),
            ),
          ),
        ]);
        raw = result.raw;
        parsed = result.parsed;
        contextChunks = result.contextChunks;
      } finally {
        clearTimeout(timeoutId);
      }

      // Persist turn
      session.messages.push(
        { role: "user", content: message },
        { role: "assistant", content: raw },
      );

      while (session.messages.length > SESSION_MAX_MESSAGES) {
        session.messages.splice(0, 2);
      }

      // ── Fire-and-forget log — never delays the response ──────────────────
      writeLog({
        reqId,
        timestamp: new Date().toISOString(),
        sessionId,
        mode,
        question: message,
        responseEnvelope: parsed,
        durationMs: Date.now() - startTime,
      });

      return c.json(
        {
          response: parsed,
          contextChunks: contextChunks.map((chunk) => {
            const sourcePdf = manifestMap.get(chunk.chunk_id);
            return {
              chunk_id: chunk.chunk_id,
              topic: chunk.topic,
              summary: chunk.summary,
              file: sourcePdf || chunk.file.replace(/^\/data\/chunks\//, ""),
            };
          }),
        },
        200,
        { "X-Request-Id": reqId },
      );
    } catch (err: any) {
      const isTimeout = err?.message === "Request timed out";
      console.error(`[${reqId}] /api/chat error:`, err);

      if (isTimeout) {
        return c.json(
          {
            error: "The AI is taking too long to respond. Please try again.",
            code: "TIMEOUT",
            reqId,
          },
          504,
        );
      }
      return c.json({ error: "Internal server error", reqId }, 500);
    }
  }); // end runWithRequestId
});

// ─── Graceful shutdown ───────────────────────────────────────────────────────
//
// On SIGTERM (Docker stop, PM2 reload) or SIGINT (Ctrl+C):
//   1. Stop accepting new connections (Bun server close is implicit via exit).
//   2. Give in-flight requests up to 5s to drain.
//   3. Exit cleanly so the process manager can restart without orphan processes.

let isShuttingDown = false;

function shutdown(signal: string): void {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n⏹  ${signal} received — graceful shutdown initiated`);

  // Allow up to 5 seconds for in-flight requests to complete
  setTimeout(() => {
    console.log("✅ Shutdown complete");
    process.exit(0);
  }, 5_000).unref(); // .unref() so the timer doesn't keep the event loop alive
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ─── Periodic stale session cleanup ─────────────────────────────────────────
// Runs every 5 minutes regardless of request traffic.

setInterval(pruneStale, 5 * 60 * 1000).unref();

// ─── Start ────────────────────────────────────────────────────────────────────

export default {
  port: 3000,
  fetch: app.fetch,
};
