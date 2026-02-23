import * as readline from "readline/promises";
import { stdin as input, stdout as output } from "process";
import { readFile } from "fs/promises";
import { join } from "path";
import { answerTroubleshootingQuestion } from "./llm-client.js";
import type { ChatResponse } from "./schemas.js";

const GUIDE_PATH = join(process.cwd(), "data", "guide.yaml");

// ─── CLI renderer ─────────────────────────────────────────────────────────────
// Renders parsed ChatResponse components as readable terminal output.

function renderResponse(parsed: ChatResponse | ChatResponse[]): void {
  const items = Array.isArray(parsed) ? parsed : [parsed];

  for (const item of items) {
    console.log("");

    switch (item.type) {
      case "steps": {
        const { title, intro, steps, followUp } = item.data;
        console.log(`📋 ${title}`);
        if (intro) console.log(`   ${intro}`);
        console.log("");
        steps.forEach((step, i) => {
          console.log(`   ${i + 1}. ${step.title}`);
          console.log(`      ${step.body}`);
        });
        if (followUp) console.log(`\n❓ ${followUp}`);
        break;
      }

      case "choices": {
        const { question, options } = item.data;
        console.log(`❓ ${question}`);
        options.forEach((opt, i) => {
          const desc = opt.description ? ` — ${opt.description}` : "";
          console.log(`   ${i + 1}. ${opt.label}${desc}`);
        });
        break;
      }

      case "alert": {
        const { severity, title, body } = item.data;
        const icon =
          severity === "danger" ? "🚨" : severity === "warning" ? "⚠️ " : "ℹ️ ";
        console.log(`${icon} ${title}`);
        console.log(`   ${body}`);
        break;
      }

      case "checklist": {
        const { title, items: checkItems } = item.data;
        console.log(`✅ ${title}`);
        checkItems.forEach((ci) => console.log(`   ☐ ${ci}`));
        break;
      }

      case "image": {
        const { caption, description } = item.data;
        console.log(`🖼  ${caption}`);
        console.log(`   ${description}`);
        break;
      }

      case "escalation": {
        const { reason, summary, ctaLabel } = item.data;
        console.log(`🔺 Escalation needed`);
        console.log(`   Reason: ${reason}`);
        console.log(`   Summary: ${summary}`);
        console.log(`   → ${ctaLabel}`);
        break;
      }

      case "summary": {
        const { title, body } = item.data;
        console.log(`✅ ${title}`);
        console.log(`   ${body}`);
        break;
      }

      case "text":
      default: {
        console.log(`   ${"data" in item ? item.data.body : String(item)}`);
        break;
      }
    }
  }

  console.log("");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function startChat() {
  console.log("🔧 Troubleshooting Assistant - Interactive Mode\n");

  // Confirm guide.yaml exists and show available processes
  let processCount = 0;
  try {
    const guide = await readFile(GUIDE_PATH, "utf-8");
    const blocks = guide
      .split(/^\s{2}- chunk_id:/m)
      .filter((b) => b.trim() && !b.trim().startsWith("#"));
    processCount = blocks.length;

    console.log("Available processes:");
    for (const block of blocks) {
      const processId = block.match(/^\s*([^\n]+)/)?.[1]?.trim() ?? "";
      const processName = block.match(/\n\s+topic:\s*(.+)/)?.[1]?.trim() ?? "";
      const description =
        block.match(/description:\s*"?([^"\n]+)"?/)?.[1]?.trim() ?? "";
      console.log(`  • [${processId}] ${processName}: ${description}`);
    }
  } catch {
    console.error(
      "❌ guide.yaml not found. Run extraction first: bun run extract <file>",
    );
    process.exit(1);
  }

  if (processCount === 0) {
    console.error(
      "❌ No processes found in guide.yaml. Run extraction first: bun run extract <file>",
    );
    process.exit(1);
  }

  console.log('\nType your question or "exit" to quit\n');

  const conversationHistory: Array<{
    role: "user" | "assistant";
    content: string;
  }> = [];

  const rl = readline.createInterface({ input, output });

  while (true) {
    try {
      const question = await rl.question("You: ");

      if (!question.trim()) continue;

      if (
        question.toLowerCase() === "exit" ||
        question.toLowerCase() === "quit"
      ) {
        console.log("\nGoodbye!");
        rl.close();
        process.exit(0);
      }

      console.log("\nAssistant:");

      try {
        const { raw, parsed } = await answerTroubleshootingQuestion(
          question,
          conversationHistory,
        );

        renderResponse(parsed);

        // Store raw string in history so LLM has context next turn
        conversationHistory.push(
          { role: "user", content: question },
          { role: "assistant", content: raw },
        );

        if (conversationHistory.length > 10) {
          conversationHistory.splice(0, 2);
        }
      } catch (apiError) {
        console.error("\nAPI Error:", apiError);
        console.log("Please check your API key in .env file\n");
      }
    } catch (error) {
      console.error("\nError:", error);
      console.log("");
    }
  }
}

startChat().catch(console.error);
