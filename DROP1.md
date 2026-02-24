# DROP 1 Deliverables

### 1. Define chunk schema

- **File:** `src/schemas.ts`
- **Fields:** `chunk_id`, `topic`, `summary`, `triggers`, `has_conditions`, `escalation`, `related_chunks`, `status`.
- **Status:** Finalized and frozen.

### 2. Define guide schema

- **File:** `src/schemas.ts`
- **Fields:** `chunk_id`, `topic`, `summary`, `triggers`, `has_conditions`, `escalation`, `related_chunks`, `status`, `file`.
- **Status:** Finalized and frozen.

### 3. Implement schema validation

- **Source:** `src/scripts/validate.ts` (Phase 1) and `src/scripts/validate-guide.ts`.
- **Logic:** Uses Zod to verify every chunk and every guide entry against the official schemas.
- **Status:** Done.

### 4. Implement guide size enforcement

- **Source:** `src/scripts/rebuild-guide.ts`.
- **Logic:** Monitors total character count of `guide.yaml` during generation; warns if it exceeds 30,000 characters (LLM performance threshold).
- **Status:** Done.

### 5. Markdown ingestion module

- **Source:** `src/llm-client.ts` (see `loadChunk` and metadata parsing logic).
- **Logic:** Handles reading and parsing `.md` files from `data/chunks/`; extracts AI-ready content and front matter metadata.
- **Status:** Done.

### 6. Semantic chunk splitter v1

- **Source:** `src/chunker.ts` (see `segmentDocument`).
- **Logic:** Identifies structural boundaries (headings, page breaks) to ensure chunks contain complete, logical context instead of arbitrary word counts.
- **Status:** Done.

### 7. Chunk ID generator

- **Source:** `src/chunker.ts` (see `deriveChunkId`).
- **Logic:** Generates deterministic, human-readable IDs by hashing chunk content and combining it with slugified heading paths.
- **Status:** Done.

### 8. Chunk persistence layer

- **Source:** `src/extract.ts` (see `assembleChunkMarkdown` and `writeFile`).
- **Logic:** Orchestrates saving processed LLM outputs to long-term storage as Markdown files with YAML front matter.
- **Status:** Done.

### 9. Front matter extractor

- **Source:** `src/scripts/rebuild-guide.ts` (see `extractFrontMatter`).
- **Logic:** Uses regex-based parsing to isolate metadata from chunk files without loading full content.
- **Status:** Done.

### 10. Guide aggregator

- **Source:** `src/scripts/rebuild-guide.ts` (the `main` routine).
- **Logic:** Iterates over all chunks to compile a centralized `guide.yaml` index (the single source of truth for the KB).
- **Status:** Done.

### 11. Guide normalization

- **Source:** `src/scripts/rebuild-guide.ts`.
- **Logic:** Standardizes formatting in the index, ensuring consistent quote usage and stripping accidental prefixes (like `chunk_id:`) from ID fields.
- **Status:** Done.

### 12. Status filtering logic

- **Source:** `src/scripts/rebuild-guide.ts`.
- **Logic:** Automatically excludes chunks marked as `review` or `deprecated` from the active index, preventing the AI from using untrusted data.
- **Status:** Done.

### 13. Guide loader module

- **Source:** `src/llm-client.ts` (see `loadGuide`).
- **Logic:** Loads the `guide.yaml` index into memory with built-in caching (`_guideCache`) to ensure high-performance lookups during chat.
- **Status:** Done.

### 14. Retrieval prompt builder

- **Source:** `src/llm-client.ts` (inside `retrieveRelevantChunks`).
- **Logic:** Dynamically constructs the specific instructions that tell the LLM how to parse the `guide.yaml` and select the best chunk IDs for a question.
- **Status:** Done.

### 15. LLM retrieval wrapper

- **Source:** `src/llm-client.ts` (see `retrieveRelevantChunks`).
- **Logic:** A dedicated async function that handles the complex logic of sending the guide and conversation history to the AI specifically for finding chunks.
- **Status:** Done.

### 16. Chunk ID parser

- **Source:** `src/llm-client.ts` (see `cleanJson` and `JSON.parse` logic).
- **Logic:** Robustly extracts the final array of IDs from the LLM's text response, removing markdown fences or conversational filler to get raw data.
- **Status:** Done.

### 17. Retrieval CLI scaffold

- **File:** `src/main.ts`.
- **Logic:** The interactive Command Line Interface (`bun run chat`) that orchestrates the user interaction, retrieval, and rendering of AI answers.
- **Status:** Done.

### 18. Debug formatter

- **File:** `src/main.ts` (triggered by `--debug` flag).
- **Logic:** A special "Developer View" that prints a detailed evidence box showing exactly which chunk IDs and content the AI retrieved before answering.
- **Status:** Done.

### 19. Pilot dataset ingestion

- **Source:** `data/chunks/`
- **Logic:** We can't show the client a blank system. We process their actual documents (like the HWL manuals) through the automated pipeline so the chatbot has real, relevant knowledge to talk about during the demo.
- **Status:** Done.

### 20. Manual summary refinement

- **Source:** Human edits to `data/chunks/*.md`.
- **Logic:** The AI does a great job writing summaries, but a human still needs to quickly review and tweak them to ensure they perfectly match the client's business logic and jargon.
- **Status:** In Progress.

### 21. Trigger refinement

- **Source:** Human edits to `data/chunks/*.md`.
- **Logic:** "Triggers" are the questions the AI thinks a user will ask. A human manually adds real-world slang or specific phrasing to this list in the `.md` file so the chatbot never misses a messy user query.
- **Status:** In Progress.

### 22. Retrieval accuracy test set

- **File:** `data/test-queries.json`.
- **Logic:** A "Final Exam" or "Gold Standard" cheat sheet. It is a manually created list of specific questions paired with the exact chunks the AI _must_ find if it wants to pass.
- **Status:** Done.

### 23. Retrieval evaluation run

- **Source:** `src/scripts/eval-retrieval.ts` (`bun run score`).
- **Logic:** The automated scoring script that forces the AI to take the "Final Exam" and generates a percentage score (e.g., "100% accuracy"). It proves to the client that the search actually works mathematically.
- **Status:** Done.
