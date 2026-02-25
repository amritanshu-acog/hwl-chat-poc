# Core Project Scripts Reference

This document provides a quick reference for every script available in the `troubleshooting-poc` directory. These commands form the backbone of your data ingestion pipeline and chat system.

All commands should be executed via `bun run <command-name>`.

---

## The Primary Workflows

### 1. `bun run ingest <pdf-file-or-dir>`

- **File:** `src/scripts/ingest.ts`
- **What it does:** The master orchestration script. This handles the end-to-end processing of new PDFs by running the four pipeline steps (`extract` → `validate` → `relate` → `rebuild`) sequentially.
- **When to use:** Whenever you need to add brand new PDF manuals into the specific AI knowledge base.

### 2. `bun run chat`

- **File:** `src/main.ts`
- **What it does:** Launches the interactive Command Line Interface (CLI) where you can chat with the AI assistant. It does not require a server.
- **Flags:**
  - `--debug`: The "Developer View". Using `bun run chat --debug` triggers the Evidence Box, printing exactly which files the AI was handed before it answered.
- **When to use:** When you want to immediately test how the AI will respond to a user query.

### 3. `bun run server`

- **File:** `src/server.ts`
- **What it does:** Boots up the Hono HTTP API on `localhost:3000`. Exposes `/api/health` and `/api/chat` for the final frontend React applications to interface with.
- **When to use:** When you need to connect your frontend UI to the backend engine for a fully visual demonstration.

---

## 🏗️ Pipeline: Individual Steps (Ingestion Flow)

If you don't use `ingest`, you can run these individual steps manually to build your index.

### 4. `bun run extract <pdf-file>`

- **File:** `src/extract.ts`
- **What it does:** (Step 1) Reads a PDF, dynamically chunks the document by headings, passes it to the LLM to extract the data, and outputs `.md` markdown files. It updates `source-manifest.json` with the original PDF mapping.
- **Flags:**
  - `--type=qna`: Switches the LLM prompt to heavily prioritize Question/Answer formats instead of generic standard operating procedures.

### 5. `bun run validate`

- **File:** `src/scripts/validate.ts`
- **What it does:** (Step 2) Quality Control. It first runs a fast Zod structural pass ensuring the chunks haven't broken any JSON limits. Then it queries the LLM to rate the Clarity, Consistency, and Completeness of the newly extracted chunks.

### 6. `bun run relate`

- **File:** `src/scripts/relate.ts`
- **What it does:** (Step 3) Graph generation. Asks the AI to identify sibling or child relationships between chunks, updating the `related_chunks` lists inside the `.md` front-matter to connect concepts for better Retrieval.

### 7. `bun run rebuild`

- **File:** `src/scripts/rebuild-guide.ts`
- **What it does:** (Step 4) Compiles all active `.md` chunk files into the unified `guide.yaml` index. It physically removes any chunks marked `status: review` or `status: deprecated`.

---

## 🧪 Testing & Evaluation Scripts

### 8. `bun run score`

- **File:** `src/scripts/eval-retrieval.ts`
- **What it does:** Automates accuracy testing for the retrieval architecture. It runs queries from `data/test-queries.json` and measures whether the AI successfully retrieves the exact expected `chunk_id`s, outputting a percentage score.

### 9. `bun run e2e-test` (or `bun run test`)

- **File:** `src/scripts/e2e-test.ts`
- **What it does:** Regression structure testing. Rapidly validates that `guide.yaml` and the `/data/chunks` folder align perfectly. Checks all chunks against `Zod` models, validates front matter rules, and ensures `## Context`, `## Response`, and `## Escalation` headers are present. (Runs in milliseconds, no LLM cost).

### 10. `bun run validate-guide`

- **File:** `src/scripts/validate-guide.ts`
- **What it does:** Targeted, fast structural check specifically on the `guide.yaml` index alone.

---

## 🛠️ Utilities & Maintenance

### 11. `bun run chunk <pdf-file>`

- **File:** `src/scripts/chunk-debug.ts`
- **What it does:** Debugging tool that bypasses the LLM entirely. It runs a PDF through the deterministic chunker engine and saves each segmented block of text as a `.txt` file into `data/debug-chunks/`.
- **When to use:** When you want to visualize exactly how the document is being sliced and exactly what text is being sent to the AI during extraction.

### 12. `bun run perf-report`

- **File:** `src/scripts/perf-report.ts`
- **What it does:** Data analytics tool. Scans the ingestion histories in `data/reports/` and aggregates metrics, providing an average duration summary and failure rate for each step across extraction/validation pipelines.

### 12. `bun run delete <chunk_id>`

- **File:** `src/scripts/delete.ts`
- **What it does:** Safely deletes a specific chunk from the knowledge base by purging its `.md` file from `/data/chunks/` and immediately stripping it out of `guide.yaml`.
