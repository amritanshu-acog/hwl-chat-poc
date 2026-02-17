import { generateText, streamText, Output, stepCountIs } from "ai";
import { getModel } from "./providers.js";
import { loadPrompt } from "./prompt-loader.js";
import { TroubleshootingProcessSchema } from "./schemas.js";
import { type Tools } from "./tools.js";

// ─── Lazy-initialised model (created once on first use) ────────────────────────

let _model: ReturnType<typeof getModel> | null = null;

function model() {
  if (!_model) _model = getModel();
  return _model;
}

// ─── Extraction ────────────────────────────────────────────────────────────────

/**
 * Extract troubleshooting processes from document content using LLM
 * with **structured output** (AI SDK `Output.array()` + Zod schema).
 *
 * This eliminates the need for manual JSON parsing or repair — the SDK
 * validates each element against `TroubleshootingProcessSchema` automatically.
 */
export async function extractProcessesFromDocument(
  content: string,
  isPdf: boolean = false,
): Promise<any[]> {
  console.log("Sending document to LLM for extraction...\n");

  const systemPrompt = await loadPrompt("extraction");

  try {
    const messages = isPdf
      ? [
          {
            role: "user" as const,
            content: [
              {
                type: "text" as const,
                text: "Extract all troubleshooting processes from this PDF.",
              },
              {
                type: "file" as const,
                data: content,
                mediaType: "application/pdf",
              },
            ],
          },
        ]
      : [
          {
            role: "user" as const,
            content: `Extract all troubleshooting processes from this document:\n\n${content}`,
          },
        ];

    const { output } = await generateText({
      model: model(),
      system: systemPrompt,
      messages,
      temperature: 0.4,
      output: Output.array({
        element: TroubleshootingProcessSchema,
      }),
    });

    if (!output) {
      console.error("⚠️  LLM returned no structured output");
      return [];
    }

    console.log(
      `✅ Received ${output.length} validated process(es) from LLM\n`,
    );
    return output;
  } catch (error) {
    console.error("Error extracting processes:", error);
    console.log(
      "\n💡 Tip: Try splitting your PDF into smaller sections (10-20 pages each)",
    );
    throw error;
  }
}

// ─── Chat / Troubleshooting ────────────────────────────────────────────────────

/**
 * Answer a troubleshooting question using the LLM with tools.
 */
export async function answerTroubleshootingQuestion(
  question: string,
  tools: Tools,
  conversationHistory: Array<{
    role: "user" | "assistant";
    content: string;
  }> = [],
) {
  const systemPrompt = await loadPrompt("chat");

  try {
    console.log("🔍 Calling LLM...");
    console.log("Question:", question);

    const result = await streamText({
      model: model(),
      system: systemPrompt,
      messages: [...conversationHistory, { role: "user", content: question }],
      tools,
      temperature: 0.2,
      stopWhen: stepCountIs(3),
    });

    return result;
  } catch (error) {
    console.error("❌ Error calling LLM:", error);
    if (error instanceof Error) {
      console.error("Error message:", error.message);
      console.error("Error stack:", error.stack);
    }
    throw error;
  }
}
