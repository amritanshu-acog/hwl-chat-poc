# DROP 2 Deliverables (Generation & Interface)

### 1. Define response envelope schema

- **File:** `src/schemas.ts` (`ChatResponseSchema`).
- **Logic:** Forces the AI to reply in a strict, predictable JSON format (like `type: "text"` or `type: "choices"`) so the interface knows exactly how to display it.
- **Status:** Done.

### 2. Envelope validator

- **Source:** `src/llm-client.ts` (`parseChatResponse`).
- **Logic:** A safety check that uses Zod to inspect the AI's final JSON output. If the AI hallucinates bad formatting, this catches it before the app crashes.
- **Status:** Done.

### 3. Generation prompt builder

- **Source:** `src/llm-client.ts` (`answerTroubleshootingQuestion`).
- **Logic:** Assembles the "Context Block" and "Mode Block" (e.g., clarify vs. answer). This is the secret instruction manual given to the AI right before it speaks, telling it exactly how to use the chunks it found.
- **Status:** Done.

### 4. Generation LLM wrapper

- **Source:** `src/llm-client.ts` (`answerTroubleshootingQuestion`).
- **Logic:** The second and final AI call. It takes the built prompt and the user's question, sends them to the LLM, and waits for the final formatted answer to return.
- **Status:** Done.

### 5. Integrate retrieval + generation

- **Source:** `src/llm-client.ts` (`answerTroubleshootingQuestion`).
- **Logic:** The orchestration function that connects the two halves of the brain: it takes the user question, runs the retrieval engine to find chunks, physically loads those text files, and seamlessly passes them into the generation wrapper.
- **Status:** Done.

### 6. Citation extraction logic

- **Source:** `src/main.ts` and `src/llm-client.ts` (`contextChunks`).
- **Logic:** Instead of relying on the LLM to hallucinate or manually track citations in its JSON output, the system deterministically tracks and exports the exact `chunk_id`s that were fed into the generation prompt, providing a 100% accurate citation trail for the frontend (or debug CLI) to display.
- **Status:** Done (via deterministic mapping, rather than LLM extraction).
