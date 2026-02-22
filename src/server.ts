import { Hono } from "hono";
import { cors } from "hono/cors";
import { readFile } from "fs/promises";
import { join } from "path";
import { answerTroubleshootingQuestion } from "./llm-client.js";

// ─── Types ──────────────────────────────────────────────────────────────────────

type Message = { role: "user" | "assistant"; content: string };
type Session = { messages: Message[]; lastAccess: number };

// ─── App & state ────────────────────────────────────────────────────────────────

const app = new Hono();
const sessions = new Map<string, Session>();

const SESSION_MAX_MESSAGES = 20;
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

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
let processCount = 0;

try {
  const guide = await readFile(GUIDE_PATH, "utf-8");
  processCount = (guide.match(/chunk_id:/gm) ?? []).length;
  console.log(`\n🚀 Server ready — ${processCount} processes in guide.yaml\n`);
} catch {
  console.warn("⚠️  guide.yaml not found. Run bun run extract first.");
}

console.log("🌐 Listening on http://localhost:3000");

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
  return c.json({ status: "ok", processesLoaded: processCount });
});

// List all processes from guide.yaml
app.get("/api/processes", async (c) => {
  try {
    const guide = await readFile(GUIDE_PATH, "utf-8");
    const processes: Array<{
      processId: string;
      processName: string;
      description: string;
      tags: string[];
    }> = [];

    const blocks = guide
      .split(/^- processId:/m)
      .filter((b) => b.trim() && !b.trim().startsWith("#"));
    for (const block of blocks) {
      const processId = block.match(/^\s*(.+)/)?.[1]?.trim() ?? "";
      const processName =
        block.match(/processName:\s*"?([^"\n]+)"?/)?.[1]?.trim() ?? "";
      const description =
        block.match(/description:\s*"?([^"\n]+)"?/)?.[1]?.trim() ?? "";
      const tagsMatch = block.match(/tags:\s*\[([^\]]*)\]/);
      const tags = tagsMatch
        ? tagsMatch[1]
            .split(",")
            .map((t) => t.trim().replace(/"/g, ""))
            .filter(Boolean)
        : [];

      if (processId && processName) {
        processes.push({ processId, processName, description, tags });
      }
    }

    return c.json({ processes, count: processes.length });
  } catch (err) {
    console.error("[/api/processes] Error:", err);
    return c.json({ error: "Failed to read guide.yaml" }, 500);
  }
});

/**
 * POST /api/chat
 *
 * Request body: { message: string, sessionId: string }
 *
 * Response: JSON envelope the frontend uses to render MDX components.
 * Single response:  { type, data }
 * Multiple responses: [{ type, data }, { type, data }, ...]
 *
 * The frontend MessageBubble reads `type` and renders the matching component.
 */
app.post("/api/chat", async (c) => {
  try {
    const body = await c.req.json();
    const { message, sessionId } = body;

    if (!message || !sessionId) {
      return c.json(
        { error: "Both 'message' and 'sessionId' are required" },
        400,
      );
    }

    pruneStale();
    const session = getSession(sessionId);

    const { raw, parsed } = await answerTroubleshootingQuestion(
      message,
      session.messages,
    );

    // Persist turn — store raw string for conversation history context
    session.messages.push(
      { role: "user", content: message },
      { role: "assistant", content: raw },
    );

    while (session.messages.length > SESSION_MAX_MESSAGES) {
      session.messages.splice(0, 2);
    }

    // Return parsed JSON directly — frontend handles rendering
    return c.json(parsed);
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
