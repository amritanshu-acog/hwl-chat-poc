import { generateText, streamText, stepCountIs } from "ai";
import { google } from "@ai-sdk/google";
import { type Tools } from "./tools.js";

// Check if API key is loaded
const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
if (!apiKey) {
  console.error(
    "❌ ERROR: GOOGLE_GENERATIVE_AI_API_KEY not found in environment variables!",
  );
  console.error("Make sure your .env file exists and contains the API key.");
  process.exit(1);
}

console.log("✅ API Key loaded:", apiKey.substring(0, 10) + "...");

const model = google("gemini-2.5-flash");

/**
 * System prompt for document extraction — produces node-based process JSON
 */
const EXTRACTION_SYSTEM_PROMPT = `You are a technical documentation parser. Extract troubleshooting processes from the provided text.


For each distinct troubleshooting process found in the document, produce a JSON object following this EXACT schema:


{
 "processId": "unique-lowercase-id",
 "processName": "Human Readable Name",
 "description": "What this process troubleshoots",
 "tags": ["keyword1", "keyword2"],
 "version": "1.0",
 "entryCriteria": {
   "keywords": ["phrases that would trigger this process"],
   "requiredContext": []
 },
 "nodes": [
   {
     "nodeId": "N1",
     "type": "question",
     "instruction": "What the user should check or do.",
     "question": "A yes/no or multiple-choice question to ask the user.",
     "validationHint": "How to verify the answer.",
     "next": {
       "yes": "N2",
       "no": "N1_FIX"
     }
   },
   {
     "nodeId": "N1_FIX",
     "type": "action",
     "instruction": "Corrective action to take.",
     "next": {
       "default": "N2"
     }
   },
   {
     "nodeId": "RESOLVED",
     "type": "resolution",
     "message": "Issue should now be resolved."
   }
 ]
}


NODE TYPES:
- "question": Ask the user a yes/no or choice question. Must have "question" and "next" with branching keys.
- "action": Tell the user to perform an action. Has "instruction" and "next" with "default" key.
- "decision": A conditional check. Has "question" and "next" with branching keys.
- "info": Informational text. Has "instruction" and "next" with "default" key.
- "resolution": Terminal node. Has "message". No "next".


RULES:
1. Every process MUST have at least one resolution node.
2. All "next" values must reference valid nodeIds within the same process.
3. Use descriptive nodeIds like "N1", "N2", "N1_FIX", "RESOLVED", "END_UNRESOLVED".
4. Extract ALL troubleshooting paths including fix/remediation branches.
5. Return ONLY a valid JSON array, no other text.


Format: [{ "processId": "...", ... }, ...]`;

/**
 * System prompt for chat-based troubleshooting — incremental step execution
 */
const CHAT_SYSTEM_PROMPT = `You are a Troubleshooting Orchestrator AI.


Your job is to guide users through structured troubleshooting processes while maintaining conversational naturalness.


WORKFLOW:
1. When user describes an issue, use searchProcesses to find relevant processes.
2. If multiple processes match OR the question is ambiguous, present at most 2 options and ask the user to choose. Always show the processId alongside the name.
3. Once the user selects a process (by name, number, or description), use getProcessDetails with the EXACT processId from the search results (e.g. "smtp-connection-issue", NOT the display name).
4. Walk the user through the process ONE NODE AT A TIME.


CRITICAL — USING processId:
- searchProcesses returns objects with a "processId" field (e.g. "smtp-sending-to-email-server-config-2").
- When calling getProcessDetails, you MUST use this exact processId string, NOT the processName.
- If the user selects an option by name or number, map it back to the processId from the search results you already received.


HANDLING FOLLOW-UP MESSAGES:
- When the user gives a short follow-up (like "sending", "auth error", "yes", "option 1"), use the CONVERSATION HISTORY to understand context.
- Do NOT call searchProcesses with just the short follow-up text. Instead, combine it with the context of what was previously discussed.
- If you already offered options and the user picks one, go directly to getProcessDetails with the corresponding processId.
- If the user's follow-up narrows down the issue (e.g. "auth error" after you asked about SMTP), use searchProcesses with a more complete query combining context (e.g. "smtp authentication error").


INCREMENTAL STEP EXECUTION RULES:
- NEVER dump all steps at once.
- Only present ONE step/question at a time.
- For "question" or "decision" nodes: ask the question from the node and wait for the user's response.
- For "action" nodes: give the instruction and ask the user to confirm when done.
- For "info" nodes: present the information and move to the next node.
- For "resolution" nodes: present the resolution message and end.
- Based on the user's response (yes/no/etc.), follow the "next" branching to the correct next nodeId.


SKIP LOGIC:
- If the user says they already completed certain checks, mark those nodes as complete and continue from the next unresolved node.


INTERACTION STYLE:
- Ask a validation question for each step.
- Provide short, actionable instructions.
- Wait for the user's response before proceeding.
- Do NOT expose internal nodeIds, JSON structure, or state variables.
- Respond conversationally.


OUT-OF-SCOPE HANDLING:
- If searchProcesses returns no results: "This issue does not match any known troubleshooting process. Could you provide the exact error message?"
- If the conversation diverges, attempt to re-align to the current process.


COMPLIANCE:
- Do not skip steps unless the user explicitly confirms completion.
- Follow process node order and branching exactly.
- Copy instructions VERBATIM from the node data — do not rephrase or summarize.


Available tools:
- searchProcesses: Find processes by keywords (use FIRST). Returns processId, name, description, tags.
- getProcessDetails: Get full process data. Pass the exact processId from search results.
- listAvailableProcesses: Show all available processes.
- askClarification: Present options when ambiguous (max 2 options).`;

/**
 * Extract troubleshooting processes from document text using LLM
 */
/**
 * Attempt to repair truncated or malformed JSON from LLM output
 */
function repairJson(jsonStr: string): string {
  // Remove trailing commas before } or ]
  jsonStr = jsonStr.replace(/,(\s*[}\]])/g, "$1");

  // Fix truncated strings — close any open quote
  const quoteCount = (jsonStr.match(/(?<!\\)"/g) || []).length;
  if (quoteCount % 2 !== 0) {
    jsonStr += '"';
  }

  // Count open/close brackets and braces
  let openBraces = 0,
    openBrackets = 0;
  let inString = false;
  let prevChar = "";

  for (const ch of jsonStr) {
    if (ch === '"' && prevChar !== "\\") {
      inString = !inString;
    }
    if (!inString) {
      if (ch === "{") openBraces++;
      else if (ch === "}") openBraces--;
      else if (ch === "[") openBrackets++;
      else if (ch === "]") openBrackets--;
    }
    prevChar = ch;
  }

  // Close any unclosed braces/brackets
  while (openBraces > 0) {
    jsonStr += "}";
    openBraces--;
  }
  while (openBrackets > 0) {
    jsonStr += "]";
    openBrackets--;
  }

  // Final trailing comma cleanup (may have been introduced)
  jsonStr = jsonStr.replace(/,(\s*[}\]])/g, "$1");

  return jsonStr;
}

export async function extractProcessesFromDocument(
  text: string,
): Promise<any[]> {
  console.log("Sending document to LLM for extraction...\n");

  // Truncate if too long (Gemini has token limits)
  const maxChars = 100000; // ~25k tokens
  if (text.length > maxChars) {
    console.log(
      `⚠️  Document too large (${text.length} chars). Truncating to ${maxChars} chars.`,
    );
    text = text.substring(0, maxChars);
  }

  try {
    const { text: response } = await generateText({
      model,
      system: EXTRACTION_SYSTEM_PROMPT,
      prompt: `Extract all troubleshooting processes from this document. Return ONLY a JSON array with no additional text:\n\n${text}`,
      temperature: 0.1,
      maxTokens: 16000,
    });

    console.log("Received response from LLM\n");

    // Log raw response for debugging
    console.log("📝 Raw response length:", response.length, "chars");
    console.log(
      "📝 Response tail (last 200 chars):",
      response.substring(response.length - 200),
    );
    console.log("");

    // Try to find JSON array in response
    let jsonStr: string | null = null;

    // Method 1: Extract from markdown code blocks
    const codeBlockMatch = response.match(
      /```(?:json)?\s*(\[[\s\S]*?\])\s*```/,
    );
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1];
    }

    // Method 2: Find the outermost [ ... ] (greedy)
    if (!jsonStr) {
      const arrayMatch = response.match(/\[[\s\S]*\]/);
      if (arrayMatch) {
        jsonStr = arrayMatch[0];
      }
    }

    // Method 3: If response starts with [ but doesn't end with ] (truncated)
    if (!jsonStr) {
      const startIdx = response.indexOf("[");
      if (startIdx !== -1) {
        console.log("⚠️  JSON appears truncated, attempting repair...");
        jsonStr = response.substring(startIdx);
      }
    }

    if (!jsonStr) {
      console.error("No JSON array found in response");
      console.log(
        "Raw response (first 500 chars):",
        response.substring(0, 500),
      );
      return [];
    }

    // Clean up whitespace
    jsonStr = jsonStr.replace(/\n/g, " ").replace(/\s+/g, " ");

    // Try parsing directly first
    try {
      const processes = JSON.parse(jsonStr);
      return Array.isArray(processes) ? processes : [processes];
    } catch (_firstError) {
      console.log("⚠️  Initial JSON parse failed, attempting repair...");
    }

    // Repair and retry
    jsonStr = repairJson(jsonStr);

    try {
      const processes = JSON.parse(jsonStr);
      console.log("✅ JSON repair successful");
      return Array.isArray(processes) ? processes : [processes];
    } catch (repairError) {
      console.error("❌ JSON repair also failed");
      console.log(
        "Repaired JSON (first 500 chars):",
        jsonStr.substring(0, 500),
      );
      console.log(
        "Repaired JSON (last 200 chars):",
        jsonStr.substring(jsonStr.length - 200),
      );
      throw repairError;
    }
  } catch (error) {
    console.error("Error extracting processes:", error);
    console.log(
      "\n💡 Tip: Try splitting your PDF into smaller sections (10-20 pages each)",
    );
    throw error;
  }
}

/**
 * Answer a troubleshooting question using the LLM with tools
 */
export async function answerTroubleshootingQuestion(
  question: string,
  tools: Tools,
  conversationHistory: Array<{
    role: "user" | "assistant";
    content: string;
  }> = [],
) {
  try {
    console.log("🔍 Calling Gemini API...");
    console.log("Question:", question);

    const result = await streamText({
      model,
      system: CHAT_SYSTEM_PROMPT,
      messages: [...conversationHistory, { role: "user", content: question }],
      tools,
      temperature: 0.2,
      stopWhen: stepCountIs(5),
    });

    return result;
  } catch (error) {
    console.error("❌ Error calling Gemini API:", error);
    if (error instanceof Error) {
      console.error("Error message:", error.message);
      console.error("Error stack:", error.stack);
    }
    throw error;
  }
}
