import { Hono } from "hono";
import { cors } from "hono/cors";
import { readFile, appendFile, mkdir } from "fs/promises";
import { join, basename } from "path";
import { answerTroubleshootingQuestion } from "./llm-client.js";

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
  timestamp: string;
  sessionId: string;
  mode: Mode;
  question: string;
  responseEnvelope: unknown;
  durationMs: number;
}

async function writeLog(entry: LogEntry): Promise<void> {
  try {
    await appendFile(LOG_PATH, JSON.stringify(entry) + "\n", "utf-8");
  } catch (err) {
    // Log failures must never crash the server
    console.error("[logger] Failed to write log entry:", err);
  }
}

// ─── CORS ───────────────────────────────────────────────────────────────────────

app.use(
  "/api/*",
  cors({
    origin: "http://localhost:5173",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  }),
);

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

  try {
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

    pruneStale();
    const session = getSession(sessionId);

    const { raw, parsed, contextChunks } = await answerTroubleshootingQuestion(
      message,
      session.messages,
      mode,
    );

    // Persist turn
    session.messages.push(
      { role: "user", content: message },
      { role: "assistant", content: raw },
    );

    while (session.messages.length > SESSION_MAX_MESSAGES) {
      session.messages.splice(0, 2);
    }

    // Log synchronously before returning
    await writeLog({
      timestamp: new Date().toISOString(),
      sessionId,
      mode,
      question: message,
      responseEnvelope: parsed,
      durationMs: Date.now() - startTime,
    });

    return c.json({
      response: parsed,
      contextChunks: contextChunks.map((chunk) => {
        const sourcePdf = manifestMap.get(chunk.chunk_id);
        return {
          chunk_id: chunk.chunk_id,
          topic: chunk.topic,
          summary: chunk.summary,
          // Use original PDF name if available, fallback to chunk filename
          file: sourcePdf || chunk.file.replace(/^data\/chunks\//, ""),
        };
      }),
    });
  } catch (err) {
    console.error("[/api/chat] Error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

export default {
  port: 3000,
  fetch: app.fetch,
};
