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

      // Show waiting message
      // Show waiting message
      process.stdout.write("\nAssistant: ");

      try {
        const result = await answerTroubleshootingQuestion(
          question,
          tools,
          conversationHistory,
        );

        let fullResponse = "";
        let toolsUsed = false;

        // Handle tool calls AND text streaming
        for await (const part of result.fullStream) {
          if (part.type === "text-delta") {
            process.stdout.write(part.text); // Fixed: use 'text' not 'textDelta'
            fullResponse += part.text;
          } else if (part.type === "tool-call") {
            toolsUsed = true;
          } else if (part.type === "tool-result") {
          }
        }

        // If tools were used, the final response comes after tool execution
        if (toolsUsed && fullResponse.length === 0) {
          const finalText = await result.text;
          console.log(finalText);
          fullResponse = finalText;
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
        console.log(
          "Please check your GOOGLE_GENERATIVE_AI_API_KEY in .env file\n",
        );
      }
    } catch (error) {
      console.error("\nError:", error);
      console.log("");
    }
  }
}

// Start the chat
startChat().catch(console.error);
