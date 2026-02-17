# Prototype Checklist & Requirements

This document tracks the requirements for the "Troubleshooting Assistant" Prototype and maps them to the existing functionalities.

## 1. Prototype Scope

To validate the **System Architecture** outlined in `README.md` and `Explanation.md`, this prototype must demonstrate the core capability: **Taking a raw document and converting it into an interactive, hallucination-free assistance chat.**

## 2. Feature Checklist

| Status | Feature                     | Requirement                                    | Mapping to Code                                  |
| :----- | :-------------------------- | :--------------------------------------------- | :----------------------------------------------- |
| ✅     | **Ingestion: PDF Support**  | Parse text from PDF files.                     | `src/extract.ts` (uses `pdfjs-dist`)             |
| ✅     | **Ingestion: URL Support**  | Scrape text from web pages (HTML).             | `src/extract.ts` (uses `fetch` + regex)          |
| ✅     | **Core: LLM Extraction**    | Convert raw text into a structured JSON graph. | `src/llm-client.ts` (`EXTRACTION_SYSTEM_PROMPT`) |
| ✅     | **Core: Schema Validation** | Ensure processes are valid (no broken links).  | `src/schemas.ts` (`Zod` validation)              |
| ✅     | **Storage: Persistence**    | Save extracted processes as JSON files.        | `src/extract.ts` (`data/processes/`)             |
| ✅     | **Chat: CLI Interface**     | Interactive terminal for testing.              | `src/main.ts`                                    |
| ✅     | **Chat: Process Registry**  | Load and index all available processes.        | `src/registry.ts`                                |
| ✅     | **Chat: Keyword Search**    | Find the right process given a user query.     | `src/tools.ts` (`searchProcesses`)               |
| ✅     | **Chat: Step-by-Step**      | Guide user one node at a time (State Machine). | `src/llm-client.ts` (`CHAT_SYSTEM_PROMPT`)       |
| ❌     | **UX: Visuals**             | Show screenshots/diagrams for steps.           | _Planned in `future.md`_                         |
| ❌     | **Ingestion: Video**        | Extract knowledge from video files.            | _Planned in `future.md`_                         |
| ❌     | **Ingestion: Chat Logs**    | Extract knowledge from Slack/Support threads.  | _Planned in `future.md`_                         |

## 3. Success Criteria (Verification)

The prototype is considered "Complete" when we can demonstrate the following **"Happy Path"**:

1.  **Input**: Run `bun run extract ./manual.pdf`.
2.  **Output**: A valid `data/processes/xyz.json` file is created.
3.  **Interaction**:
    - Run `bun run chat`.
    - User asks "How do I fix X?".
    - Bot finds the process.
    - Bot asks "Do you see error code 50?".
    - User says "Yes".
    - Bot gives the correct fix _verbatim_ from the PDF.

## 4. Architecture Alignment

This prototype validates the **"Ingestion Engine + Execution Engine"** split described in `Explanation.md`.

- **Ingestion Engine**: Validated by `extract.ts`. It proves we can normalize unstructured data into a graph.
- **Execution Engine**: Validated by `main.ts`. It proves we can traverse that graph interactively.

## 5. Next Steps (Gap Analysis)

To move from **Prototype** to **MVP**:

1.  **Visuals**: Implement the `image_url` logic (Section 5 of `future.md`).
2.  **Scalability**: Move from `JSON files` to `SQLite/Postgres` (Scalability section in `Explanation.md`).
3.  **Web UI**: Move from CLI (`main.ts`) to a React/Next.js frontend.
