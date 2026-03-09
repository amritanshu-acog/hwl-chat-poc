import * as readline from "readline/promises";
import { stdin as input, stdout as output } from "process";
import { parseArgs } from "util";
import { runPipeline } from "../pipeline/pipeline.js";
import { Session } from "../session/session.js";
import { preload } from "../resources/resources.js";
import { CONFIG } from "../core/config.js";
import { logger } from "../core/logger.js";

// ─── Arg parsing ──────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    "user-id": { type: "string", default: "cli-user" },
    "session-id": { type: "string" },
    list: { type: "boolean", default: false },
    show: { type: "string" },
  },
  strict: false,
});

const userId = (args["user-id"] as string) ?? "cli-user";
const sessionId = args["session-id"] as string | undefined;
const listMode = (args["list"] as boolean) ?? false;
const showId = args["show"] as string | undefined;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function printCitations(citations: { chunk_id: string; source: string }[]) {
  if (citations.length === 0) return;
  const sources = [...new Set(citations.map((c) => c.source))];
  console.log(`\n📎 Sources: ${sources.join(", ")}`);
}

function printResponse(result: Awaited<ReturnType<typeof runPipeline>>) {
  console.log("\nAssistant:\n");
  console.log(result.response);
  printCitations(result.citations);
  console.log("");
}

// ─── --list: show all sessions for the user ───────────────────────────────────

async function runList() {
  const sessions = await Session.list(userId);
  if (sessions.length === 0) {
    console.log(`No sessions found for user: ${userId}`);
    return;
  }
  console.log(`\nSessions for user: ${userId}\n`);
  for (const s of sessions) {
    console.log(`  [${s.session_id.slice(0, 8)}…]  ${s.title}`);
    console.log(`    Turns: ${s.turn_count}  |  Updated: ${s.updated_at}`);
    console.log(`    File:  ${s.filename}\n`);
  }
}

// ─── --show: print conversation history for a session ─────────────────────────

async function runShow(sid: string) {
  const session = await Session.load(userId, sid);
  console.log(`\nSession: ${session.session_id}`);
  if (session.title) console.log(`Title:   ${session.title}`);
  console.log(`Created: ${session.created_at}\n`);

  for (const turn of session.turns) {
    const role = turn.role === "user" ? "You" : "Assistant";
    console.log(`${role} [window ${turn.window}]:`);
    console.log(`  ${turn.content.replace(/\n/g, "\n  ")}`);
    if ("citations" in turn && turn.citations?.length) {
      const sources = [...new Set(turn.citations.map((c: any) => c.source))];
      console.log(`  📎 Sources: ${sources.join(", ")}`);
    }
    console.log("");
  }
}

// ─── Interactive chat loop ────────────────────────────────────────────────────

async function runChat() {
  console.log("\n🤖 AI Help Bot — Retrieval Pipeline");
  console.log(`   User:    ${userId}`);
  if (sessionId) console.log(`   Session: ${sessionId}`);
  console.log('   Type your question or "exit" to quit\n');

  const rl = readline.createInterface({ input, output });
  let currentSessionId: string | undefined = sessionId;

  while (true) {
    let question: string;
    try {
      question = await rl.question("You: ");
    } catch {
      break; // stdin closed (e.g. piped input ended)
    }

    if (!question.trim()) continue;

    if (["exit", "quit"].includes(question.trim().toLowerCase())) {
      console.log("\nGoodbye!");
      rl.close();
      process.exit(0);
    }

    try {
      const result = await runPipeline(userId, question, currentSessionId);

      // Pin session after first turn so subsequent messages resume it.
      currentSessionId = result.session_id;

      if (result.response_type === "quota_exceeded") {
        console.log(`\n⚠️  ${result.response}\n`);
        rl.close();
        process.exit(0);
      }

      printResponse(result);
    } catch (err) {
      logger.error("Pipeline error", {
        err: err instanceof Error ? err.message : String(err),
      });
      console.log("\n❌ Something went wrong. Please try again.\n");
    }
  }

  rl.close();
}

// ─── Entry point ──────────────────────────────────────────────────────────────

try {
  await preload();
} catch {
  console.warn("⚠️  Some resources failed to preload — continuing anyway.");
}

if (listMode) {
  await runList();
} else if (showId) {
  await runShow(showId);
} else {
  await runChat();
}
