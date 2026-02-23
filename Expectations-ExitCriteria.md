# AI Helpbot — Exit Documentation

> **Date**: 2026-02-23  
> **Status**: POC Complete

---

## What Needs to be Built

An AI-powered helpdesk chatbot for the HWL platform. It answers customer support questions by reading from a structured knowledge base extracted from source documents (PDF manuals). When confidence is low, it escalates safely instead of guessing.

---

## Exit Criteria

The POC will be considered complete when all of the following were true:

1. **A PDF can be ingested end-to-end** — run one command, get chunk files and an updated `guide.yaml` automatically.
2. **Quality gates run before any chunk goes live** — clarity, consistency, and completeness are checked by the LLM before a chunk is used in retrieval.
3. **The API answers questions in two steps** — retrieval (which chunks are relevant) then generation (answer using those chunks).
4. **Responses are typed and structured** — the API never returns free text; it returns a typed envelope (`steps`, `choices`, `alert`, `escalation`, etc.) that a frontend can render reliably.
5. **Escalation works** — when no chunk covers the question, the bot produces an escalation response instead of inventing an answer.
6. **Sessions are tracked** — conversation history is maintained per session with a 30-minute TTL.
7. **Every request is logged** — timestamp, session ID, question, mode, response, and duration are written to `data/logs/requests.ndjson`.
8. **Content lifecycle is covered** — chunks can be extracted, validated, deleted, and the index rebuilt without manual edits to `guide.yaml`.

---

## What Was Implemented

### 1. Ingestion Pipeline (`src/extract.ts`)

- Accepts one PDF, multiple PDFs, or a directory of PDFs.
- Sends each PDF to the LLM using the `extraction` prompt.
- LLM returns a JSON array of chunks. Each chunk is schema-validated with Zod.
- Valid chunks are written to `data/chunks/<chunk_id>.md` with YAML front matter.
- `guide.yaml` is upserted automatically after each extraction run.
- **Command**: `bun run extract <file.pdf>`

### 2. Knowledge Base Structure

- **`data/chunks/*.md`** — 13 chunks covering HWL processes (requisitions, invoices, email preferences, login, candidate status, etc.).
- **`data/guide.yaml`** — auto-generated index with one entry per chunk. Contains `chunk_id`, `topic`, `summary`, `triggers`, `has_conditions`, `escalation`, `related_chunks`, `status`, and `file` path.
- Source of truth is the chunk `.md` files. `guide.yaml` is always re-derived from them.

### 3. Quality Validation (`src/scripts/validate.ts`)

- Reads all `status: active` chunks.
- For each chunk, calls the LLM to check three criteria: **Clarity**, **Consistency**, **Completeness**.
- Failing chunks are marked `status: review` in both the file and `guide.yaml`.
- Chunks in `review` state are excluded from retrieval until manually fixed and re-validated.
- **Command**: `bun run validate`

### 4. Two-Step Answering (`src/llm-client.ts`)

- **Step 1 — Retrieval**: sends `guide.yaml` + the user question to the LLM. LLM returns 2–3 relevant `chunk_id` strings.
- **Step 2 — Generation**: loads the selected chunk `.md` files and passes them as context. LLM generates a typed JSON response.
- Mode flag (`clarify` / `answer`) controls response style — `clarify` prefers choice prompts; `answer` goes directly to steps.

### 5. Typed Response Schema (`src/schemas.ts`)

Eight response types, each validated with Zod:

| Type         | Used when                                       |
| ------------ | ----------------------------------------------- |
| `steps`      | Answer is a step-by-step process                |
| `choices`    | User needs to clarify their situation first     |
| `alert`      | Warning or important constraint to surface      |
| `checklist`  | Action involves a list of items to complete     |
| `image`      | A screenshot or diagram is referenced           |
| `escalation` | No reliable answer exists; hand off to a ticket |
| `summary`    | Confirmation that a task is done                |
| `text`       | Fallback for anything else                      |

### 6. HTTP API (`src/server.ts`)

Built with Hono on Bun, port 3000.

| Endpoint          | What it does                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| `GET /api/health` | Returns server status and active chunk count                                                         |
| `GET /api/chunks` | Lists all chunks from `guide.yaml`                                                                   |
| `POST /api/chat`  | Main answering endpoint. Takes `message`, `sessionId`, optional `mode`. Returns typed JSON envelope. |

- CORS enabled for `localhost:5173` (frontend dev server).
- In-memory session store with 30-minute TTL and 20-message history cap.
- **Command**: `bun run server`

### 7. Request Logging

- Every call to `POST /api/chat` is logged synchronously before response is returned.
- Log format: newline-delimited JSON (`requests.ndjson`).
- Each entry: `timestamp`, `sessionId`, `mode`, `question`, `responseEnvelope`, `durationMs`.
- Log failures never crash the server.

### 8. Content Lifecycle Scripts

| Command                     | What it does                                                          |
| --------------------------- | --------------------------------------------------------------------- |
| `bun run extract <file>`    | Ingest a new or updated PDF                                           |
| `bun run validate`          | Quality-check all active chunks                                       |
| `bun run rebuild`           | Rebuild `guide.yaml` from chunk front matter (use after manual edits) |
| `bun run delete <chunk_id>` | Delete one chunk and rebuild the index                                |
| `bun run relate`            | Post-extraction pass to populate `related_chunks` fields              |

### 9. CLI Mode (`src/main.ts`)

Interactive terminal chat loop for testing without the HTTP server. Renders structured responses as readable terminal output using icons and formatting.

- **Command**: `bun run chat`

---

## What Is Not In Scope

These decisions were intentionally deferred and are not part of this POC:

- No persistent log sink (logs write to a local file; no database or external platform).
- No prompt versioning process.
- No authentication or rate limiting on the API.
