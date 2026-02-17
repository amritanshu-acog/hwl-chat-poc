import * as readline from "readline/promises";
import { stdin as input, stdout as output } from "process";
import { ProcessRegistry } from "./registry.js";
import { createTools } from "./tools.js";
import { answerTroubleshootingQuestion } from "./llm-client.js";

/**
 * Interactive chat mode for troubleshooting
 */
async function startChat() {
  console.log("🔧 Troubleshooting Assistant - Interactive Mode\n");

  // Load processes
  const registry = new ProcessRegistry();
  await registry.loadProcesses();

  if (registry.listProcesses().length === 0) {
    console.error(
      "No processes found. Run extraction first: bun run extract <file>",
    );
    process.exit(1);
  }

  console.log("Available processes:");
  registry.listProcesses().forEach((p) => {
    console.log(`  • [${p.processId}] ${p.name}: ${p.description}`);
  });
  console.log('\nType your question or "exit" to quit\n');

  // Create tools
  const tools = createTools(registry);

  // Conversation history
  const conversationHistory: Array<{
    role: "user" | "assistant";
    content: string;
  }> = [];

  // Create readline interface
  const rl = readline.createInterface({ input, output });

  while (true) {
    try {
      const question = await rl.question("You: ");

      if (!question.trim()) {
        continue;
      }

      if (
        question.toLowerCase() === "exit" ||
        question.toLowerCase() === "quit"
      ) {
        console.log("\nGoodbye!");
        rl.close();
        process.exit(0);
      }

      process.stdout.write("\nAssistant: ");

      try {
        const result = await answerTroubleshootingQuestion(
          question,
          tools,
          conversationHistory,
        );

        let fullResponse = "";

        for await (const part of result.fullStream) {
          if (part.type === "text-delta") {
            process.stdout.write(part.text);
            fullResponse += part.text;
          }
        }

        // Fallback: if streaming produced nothing, get the full text
        if (fullResponse.length === 0) {
          fullResponse = await result.text;
          process.stdout.write(fullResponse);
        }

        console.log("\n");

        // Add to conversation history
        conversationHistory.push(
          { role: "user", content: question },
          { role: "assistant", content: fullResponse },
        );

        // Keep history manageable (last 10 messages)
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

// Start the chat
startChat().catch(console.error);
