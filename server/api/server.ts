import { Hono } from "hono";
import { cors } from "hono/cors";
import { jwtVerify, createRemoteJWKSet } from "jose";
import { runPipeline } from "../pipeline/pipeline.js";
import { Session } from "../session/session.js";
import { preload } from "../resources/resources.js";
import { CONFIG } from "../core/config.js";
import { runWithRequestId, logger } from "../core/logger.js";
import { getBreakerState } from "../llm/client.js";

// ─── App ──────────────────────────────────────────────────────────────────────

const app = new Hono();

// ─── CORS ─────────────────────────────────────────────────────────────────────

app.use(
  "/*",
  cors({
    origin: CONFIG.server.corsOrigin,
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);

// ─── JWT Auth ─────────────────────────────────────────────────────────────────
//
// GAP FIX #3: JWT signature is now cryptographically verified using `jose`.
// The previous implementation only base64-decoded the payload — anyone could
// forge a token. Now:
//   HS256 — verified against JWT_SECRET env var (shared secret)
//   RS256 — verified against JWKS_URL or JWT_PUBLIC_KEY env var (public key)
//
// Returns null on any failure: missing header, malformed token, bad signature,
// expired token, missing user_id claim.

let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (!_jwks) {
    const url = process.env.JWKS_URL;
    if (!url) {
      throw new Error("JWKS_URL env var required for RS256 verification");
    }
    _jwks = createRemoteJWKSet(new URL(url));
  }
  return _jwks;
}

/**
 * Verify a Bearer JWT and extract the configured user_id claim.
 * Returns null on any failure — the caller should respond 401.
 */
async function authenticateRequest(
  authHeader: string | undefined,
): Promise<string | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7).trim();
  if (!token) return null;

  try {
    const algorithm = CONFIG.auth.jwtAlgorithm;

    if (algorithm === "HS256") {
      const secret = process.env.JWT_SECRET;
      if (!secret) {
        logger.error(
          "JWT_SECRET env var is not set — cannot verify HS256 tokens",
        );
        return null;
      }
      const key = new TextEncoder().encode(secret);
      const { payload } = await jwtVerify(token, key, {
        algorithms: ["HS256"],
      });
      const userId = payload[CONFIG.auth.userIdClaim];
      return typeof userId === "string" && userId.length > 0 ? userId : null;
    }

    // RS256: verify against JWKS endpoint or PEM public key.
    const publicKeyPem = process.env.JWT_PUBLIC_KEY;
    if (publicKeyPem) {
      // Import PEM-encoded public key.
      const key = await crypto.subtle.importKey(
        "spki",
        Buffer.from(
          publicKeyPem.replace(/-----[^-]+-----/g, "").replace(/\s/g, ""),
          "base64",
        ),
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      const { payload } = await jwtVerify(token, key, {
        algorithms: ["RS256"],
      });
      const userId = payload[CONFIG.auth.userIdClaim];
      return typeof userId === "string" && userId.length > 0 ? userId : null;
    }

    // Fallback to JWKS endpoint.
    const { payload } = await jwtVerify(token, getJwks(), {
      algorithms: ["RS256"],
    });
    const userId = payload[CONFIG.auth.userIdClaim];
    return typeof userId === "string" && userId.length > 0 ? userId : null;
  } catch (err) {
    logger.debug("JWT verification failed", {
      reason: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ─── Auth middleware ───────────────────────────────────────────────────────────

async function requireAuth(
  c: any,
  next: () => Promise<void>,
): Promise<Response | void> {
  const userId = await authenticateRequest(c.req.header("Authorization"));
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  c.set("userId" as never, userId);
  return next();
}

app.use("/answer", requireAuth);
app.use("/sessions", requireAuth);
app.use("/sessions/*", requireAuth);

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check — no auth required.
app.get("/health", (c) => {
  return c.json({ status: "ok", breaker: getBreakerState() });
});

/**
 * POST /answer
 * Submit a user message and receive a pipeline response.
 *
 * Body: { message: string, session_id?: string }
 * Response: TurnResult shape — session_id, action, response, response_type, citations
 */
app.post("/answer", async (c) => {
  const reqId = crypto.randomUUID().slice(0, 8);

  return runWithRequestId(reqId, async () => {
    if (isShuttingDown)
      return c.json({ error: "Server is shutting down" }, 503);

    // Body size guard.
    const contentLength = Number(c.req.header("content-length") ?? 0);
    if (contentLength > CONFIG.server.maxBodyBytes)
      return c.json({ error: "Request body too large" }, 413);

    let body: { message?: string; session_id?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { message, session_id } = body;
    if (!message || typeof message !== "string")
      return c.json({ error: "'message' is required" }, 400);

    const userId = c.get("userId" as never) as string;

    // Request timeout.
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      CONFIG.server.requestTimeoutMs,
    );

    try {
      const result = await Promise.race([
        runPipeline(userId, message, session_id),
        new Promise<never>((_, reject) =>
          controller.signal.addEventListener("abort", () =>
            reject(new Error("Request timed out")),
          ),
        ),
      ]);

      // Map quota_exceeded to HTTP 429.
      if (result.response_type === "quota_exceeded") {
        return c.json(result, 429);
      }

      return c.json(result, 200, { "X-Request-Id": reqId });
    } catch (err: any) {
      if (err?.message === "Request timed out") {
        logger.error(`[${reqId}] /answer timeout`);
        return c.json({ error: "Request timed out", code: "TIMEOUT" }, 504);
      }
      logger.error(`[${reqId}] /answer error`, { err: err?.message });
      return c.json({ error: "Internal server error" }, 500);
    } finally {
      clearTimeout(timeoutId);
    }
  });
});

/**
 * GET /sessions
 * List all sessions for the authenticated user, sorted by recency.
 */
app.get("/sessions", async (c) => {
  const userId = c.get("userId" as never) as string;
  try {
    const sessions = await Session.list(userId);
    return c.json(sessions);
  } catch (err) {
    logger.error("/sessions list error", { err });
    return c.json({ error: "Internal server error" }, 500);
  }
});

/**
 * GET /sessions/:sessionId
 * Return the full turn history for a session.
 */
app.get("/sessions/:sessionId", async (c) => {
  const userId = c.get("userId" as never) as string;
  const sessionId = c.req.param("sessionId");

  try {
    const session = await Session.load(userId, sessionId);
    return c.json({
      session_id: session.session_id,
      user_id: session.user_id,
      title: session.title,
      created_at: session.created_at,
      turns: session.turns,
    });
  } catch (err: any) {
    if (err?.message?.includes("not found"))
      return c.json({ error: "Session not found" }, 404);
    logger.error("/sessions/:id error", { err });
    return c.json({ error: "Internal server error" }, 500);
  }
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────

let isShuttingDown = false;

function shutdown(signal: string): void {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info(`${signal} received — graceful shutdown initiated`);
  setTimeout(() => {
    logger.info("Shutdown complete");
    process.exit(0);
  }, 5_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ─── Startup ──────────────────────────────────────────────────────────────────

// Warn at startup if JWT_SECRET is missing (HS256 mode) — don't crash so
// development without auth still works, but make the gap obvious.
if (CONFIG.auth.jwtAlgorithm === "HS256" && !process.env.JWT_SECRET) {
  logger.warn(
    "JWT_SECRET env var is not set. HS256 verification will reject all tokens. Set JWT_SECRET to enable auth.",
  );
}

await preload();

logger.info("Server ready", {
  corsOrigin: CONFIG.server.corsOrigin,
  timeoutMs: CONFIG.server.requestTimeoutMs,
});

console.log("🚀 Server ready — http://localhost:3000");

// ─── Export ───────────────────────────────────────────────────────────────────

export default {
  port: 3000,
  fetch: app.fetch,
};
