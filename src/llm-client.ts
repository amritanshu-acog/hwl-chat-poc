import { generateText, streamText, stepCountIs } from 'ai';
import { google } from '@ai-sdk/google';
import { type Tools } from './tools.js';

// Check if API key is loaded
const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
if (!apiKey) {
    console.error('❌ ERROR: GOOGLE_GENERATIVE_AI_API_KEY not found in environment variables!');
    console.error('Make sure your .env file exists and contains the API key.');
    process.exit(1);
}

console.log('✅ API Key loaded:', apiKey.substring(0, 10) + '...');

const model = google('gemini-2.5-flash-lite');

/**
 * System prompt for document extraction
 */
const EXTRACTION_SYSTEM_PROMPT = `You are a technical documentation parser. Extract troubleshooting processes from the provided text.

For each distinct troubleshooting process:
1. Identify the problem being solved
2. Extract all steps in exact order
3. Note any conditions (if/when statements)
4. Capture decision points (yes/no questions)
5. List prerequisites

CRITICAL: Return ONLY valid JSON array, no other text before or after.
Format: [{"processName": "...", "description": "...", ...}]

Each process must have:
- processName (string, lowercase-with-dashes)
- description (string)
- prerequisites (array of strings, can be empty [])
- steps (array of step objects)
- decisionPoints (array of decision objects, can be empty [])
- expectedResolution (string)

Step format: {"stepNumber": 1, "instruction": "...", "condition": null, "possibleOutcomes": ["..."]}
Decision format: {"question": "...", "options": [{"answer": "...", "nextStep": 1}]}`;

/**
 * System prompt for chat-based troubleshooting
 */
const CHAT_SYSTEM_PROMPT = `You are a troubleshooting assistant that retrieves information from process JSON files.

WORKFLOW:
1. When user asks a question, use searchProcesses to find relevant processes
2. If multiple processes match OR question is ambiguous, use askClarification to let user choose
3. Once you know which process, use getProcessDetails to get the JSON
4. Output the steps EXACTLY as written in the JSON

CRITICAL RULES FOR OUTPUTTING STEPS:
1. Copy the "instruction" field from each step VERBATIM - word for word
2. Do NOT summarize, rephrase, explain, or interpret the instructions
3. Do NOT use text from "description", "possibleOutcomes", or other fields as steps
4. Do NOT add your own suggestions or advice

CORRECT OUTPUT FORMAT when providing steps:
"I found the process: [processName]

Step 1: [exact text from steps[0].instruction]
Step 2: [exact text from steps[1].instruction]
Step 3: [exact text from steps[2].instruction]

Expected resolution: [exact text from expectedResolution]"

WHEN TO ASK CLARIFICATION:
- User's question matches multiple processes → use askClarification
- Question is vague (e.g., "printer not working") → use askClarification with specific options
- User mentions generic issue → search first, then clarify if multiple matches

WHEN TO SAY "I DON'T KNOW":
- searchProcesses returns no results
- Process doesn't exist in the knowledge base

Available tools:
- searchProcesses: Find processes by keywords (use this FIRST)
- getProcessDetails: Get exact JSON data for a specific process (use this LAST)
- listAvailableProcesses: Show all available processes
- askClarification: Present options when ambiguous (use this for multiple matches)

EXAMPLE FLOW:
User: "My printer isn't working"
1. Call searchProcesses("printer")
2. If 3+ processes match → askClarification with options
3. User selects option → getProcessDetails for that specific process
4. Output steps EXACTLY from JSON

You are a RETRIEVAL and ROUTING system - route user to right process, then copy exact steps from JSON.`;

/**
 * Extract troubleshooting processes from document text using LLM
 */
export async function extractProcessesFromDocument(text: string): Promise<any[]> {
    console.log('Sending document to LLM for extraction...\n');

    // Truncate if too long (Gemini has token limits)
    const maxChars = 100000; // ~25k tokens
    if (text.length > maxChars) {
        console.log(`⚠️  Document too large (${text.length} chars). Truncating to ${maxChars} chars.`);
        text = text.substring(0, maxChars);
    }

    try {
        const { text: response } = await generateText({
            model,
            system: EXTRACTION_SYSTEM_PROMPT,
            prompt: `Extract all troubleshooting processes from this document. Return ONLY a JSON array with no additional text:\n\n${text}`,
            temperature: 0.1,
            maxTokens: 8000,
        });

        console.log('Received response from LLM\n');

        // Try to find JSON array in response
        let jsonMatch = response.match(/\[[\s\S]*\]/);

        if (!jsonMatch) {
            // Try to extract from markdown code blocks
            const codeBlockMatch = response.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
            if (codeBlockMatch) {
                jsonMatch = [codeBlockMatch[1]];
            }
        }

        if (!jsonMatch) {
            console.error('No JSON array found in response');
            console.log('Raw response (first 500 chars):', response.substring(0, 500));
            return [];
        }

        let jsonStr = jsonMatch[0];

        // Clean up common JSON issues
        jsonStr = jsonStr
            .replace(/,(\s*[}\]])/g, '$1') // Remove trailing commas
            .replace(/\n/g, ' ')           // Remove newlines
            .replace(/\s+/g, ' ');         // Normalize spaces

        const processes = JSON.parse(jsonStr);
        return Array.isArray(processes) ? processes : [processes];
    } catch (error) {
        console.error('Error extracting processes:', error);
        console.log('\n💡 Tip: Try splitting your PDF into smaller sections (10-20 pages each)');
        throw error;
    }
}

/**
 * Answer a troubleshooting question using the LLM with tools
 */
export async function answerTroubleshootingQuestion(
    question: string,
    tools: Tools,
    conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = []
) {
    try {
        console.log('🔍 Calling Gemini API...');
        console.log('Question:', question);

        const result = await streamText({
            model,
            system: CHAT_SYSTEM_PROMPT,
            messages: [
                ...conversationHistory,
                { role: 'user', content: question },
            ],
            tools,
            temperature: 0.2,
            stopWhen: stepCountIs(5), // ← ADD THIS LINE!
        });

        console.log('✅ API call successful, streaming response...\n');
        return result;
    } catch (error) {
        console.error('❌ Error calling Gemini API:', error);
        if (error instanceof Error) {
            console.error('Error message:', error.message);
            console.error('Error stack:', error.stack);
        }
        throw error;
    }
}