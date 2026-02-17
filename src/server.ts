import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamText as honoStreamText } from "hono/streaming";
import { ProcessRegistry } from "./registry.js";
import { createTools } from "./tools.js";
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

// ─── Startup: load registry & tools once ────────────────────────────────────────

const registry = new ProcessRegistry();
await registry.loadProcesses();
const processCount = registry.listProcesses().length;
const tools = createTools(registry);
console.log(`\n🚀 Server ready — ${processCount} processes loaded\n`);

// ─── Helpers ────────────────────────────────────────────────────────────────────

function getSession(sessionId: string): Session {
  const now = Date.now();
  let session = sessions.get(sessionId);

  // Expired or missing → create fresh
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

// ─── Routes ─────────────────────────────────────────────────────────────────────

// Health check
app.get("/api/health", (c) => {
  return c.json({ status: "ok", processesLoaded: processCount });
});

// List all processes
app.get("/api/processes", (c) => {
  try {
    const processes = registry.listProcesses();
    return c.json({ processes, count: processes.length });
  } catch (err) {
    console.error("[/api/processes] Error:", err);
    return c.json({ error: "Failed to list processes" }, 500);
  }
});

// Chat (streaming)
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

    // Prune stale sessions occasionally
    pruneStale();

    const session = getSession(sessionId);

    const result = await answerTroubleshootingQuestion(
      message,
      tools,
      session.messages,
    );

    return honoStreamText(c, async (stream) => {
      let fullResponse = "";

      for await (const part of result.fullStream) {
        if (part.type === "text-delta") {
          await stream.write(part.text);
          fullResponse += part.text;
        }
      }

      // Fallback if streaming produced nothing
      if (fullResponse.length === 0) {
        fullResponse = await result.text;
        await stream.write(fullResponse);
      }

      // Persist conversation turn
      session.messages.push(
        { role: "user", content: message },
        { role: "assistant", content: fullResponse },
      );

      // Keep last N messages
      while (session.messages.length > SESSION_MAX_MESSAGES) {
        session.messages.splice(0, 2);
      }
    });
  } catch (err) {
    console.error("[/api/chat] Error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

// ─── Start ──────────────────────────────────────────────────────────────────────

export default {
  port: 3000,
  fetch: app.fetch,
};

console.log("🌐 Listening on http://localhost:3000");
