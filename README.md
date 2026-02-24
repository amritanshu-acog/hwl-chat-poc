# HWL Assistant

An LLM-powered helpdesk assistant that extracts knowledge from PDF documentation and answers customer questions strictly based on that knowledge.

## Features

- 📄 Extract knowledge chunks from PDF documents using LLM(currently gpt-4o)
- 🖼️ Exhaustive image and screenshot description extraction from PDFs
- 💬 Two-step runtime: retrieval from `guide.yaml` index, then structured response generation
- 🧩 Structured chunk-based knowledge base with YAML front matter
- 🛡️ Quality-gated ingestion — only validated chunks reach the live knowledge base
- 🔺 Built-in escalation path when the assistant cannot resolve an issue
- 🌐 Hono API server with session management
- ✅ Zod-validated extraction and response schemas

## Setup

1. **Install dependencies**:

   ```bash
   bun install
   ```

2. **Configure environment**:

   ```bash
   cp .env.example .env
   # Edit .env and add your GOOGLE_GENERATIVE_AI_API_KEY
   ```

3. **Create data directories**:
   ```bash
   mkdir -p data/chunks
   ```

## Usage

### Extract Knowledge from PDFs

```bash
bun run extract path/to/document.pdf
```

Multiple PDFs or a whole directory:

```bash
bun run extract a.pdf b.pdf
bun run extract ./docs/
```

This will:

- Send the PDF directly to the LLM for deep extraction
- Identify all distinct processes, procedures, and how-to guides
- Describe every image, screenshot, and diagram exhaustively
- Save each concept as a structured `.md` chunk in `data/chunks/`
- Update `data/guide.yaml` with the discovery index

### Start the API Server

```bash
bun run server
```

Runs on `http://localhost:3000`. The frontend connects to `/api/chat`.

### Interactive CLI Chat

```bash
bun run chat
```

## Architecture

### Separation of Concerns

```
Offline (extraction)          Online (runtime)
─────────────────────         ────────────────────────
PDF → LLM extraction    →     guide.yaml (retrieval index)
    → chunk .md files   →     chunk .md files (loaded on demand)
    → guide.yaml        →     LLM generates structured response
```

**Offline** — ingestion pipeline extracts and validates chunks from PDFs.  
**Online** — two LLM calls per question: (1) retrieve relevant chunk IDs from guide, (2) generate structured JSON response from loaded chunks.

### Components

| File                    | Role                                                             |
| ----------------------- | ---------------------------------------------------------------- |
| `schemas.ts`            | Zod schemas for chunks, guide entries, and chat response types   |
| `extract.ts`            | PDF ingestion, chunk `.md` assembly, `guide.yaml` updates        |
| `llm-client.ts`         | Extraction and chat LLM calls, JSON cleaning, response parsing   |
| `server.ts`             | Hono API server — `/api/chat`, `/api/health`, session management |
| `main.ts`               | CLI chat loop                                                    |
| `prompt-loader.ts`      | Loads and caches prompts from `prompts/*.md`                     |
| `prompts/extraction.md` | System prompt for PDF knowledge extraction                       |
| `prompts/chat.md`       | System prompt for structured response generation                 |

### Chunk Structure

Each chunk is a `.md` file with YAML front matter. One chunk = one concept or question.

```markdown
---
chunk_id: update-email-preferences-default
topic: Email Preferences
summary: >
  How to set email preferences to receive all notifications by default.
triggers:
  - "How do I set all email preferences to default?"
  - "Subscribe to all notifications in HWL"
has_conditions: false
escalation: null
related_chunks:
status: active
---

## Context

...

## Conditions

(only present when has_conditions: true)

## Constraints

(only present when hard system limits exist)

## Response

...

## Escalation

None required.

## Images

(exhaustive descriptions of all screenshots and diagrams from the PDF)
```

### guide.yaml Structure

Auto-generated from chunk front matter. Never edit manually — source of truth is the individual chunk files.

```yaml
chunks:
  - chunk_id: update-email-preferences-default
    topic: Email Preferences
    summary: >
      How to set email preferences to receive all notifications by default.
    triggers:
      - "How do I set all email preferences to default?"
    has_conditions: false
    escalation: null
    related_chunks:
    status: active
    file: data/chunks/update-email-preferences-default.md
```

### Chat Response Types

The API returns typed JSON that the frontend renders as components:

| Type         | When used                                                |
| ------------ | -------------------------------------------------------- |
| `steps`      | Sequential how-to process                                |
| `choices`    | Clarifying question (required when chunk has conditions) |
| `alert`      | Warnings or hard system constraints                      |
| `checklist`  | Verification or pre-flight checks                        |
| `image`      | Screenshot or diagram description                        |
| `escalation` | Issue cannot be resolved from documentation              |
| `summary`    | Issue confirmed resolved                                 |
| `text`       | Greetings, out-of-scope, conversational replies          |

## API

### `POST /api/chat`

```json
// Request
{ "message": "How do I set email preferences?", "sessionId": "abc123" }

// Response — single component
{ "type": "steps", "data": { "title": "...", "steps": [...] } }

// Response — multiple components
[
  { "type": "alert", "data": { "severity": "warning", "title": "...", "body": "..." } },
  { "type": "steps", "data": { "title": "...", "steps": [...] } }
]
```

### `GET /api/health`

```json
{ "status": "ok", "processesLoaded": 12 }
```

## Content Lifecycle Commands

### `bun run ingest <source>` — Recommended: full pipeline in one command

```bash
bun run ingest ./manual.pdf          # Single PDF
bun run ingest ./docs/               # All PDFs in a directory
bun run ingest a.pdf b.pdf           # Multiple files

# What it runs in sequence:
#   1. extract  — PDF → chunk .md files + guide.yaml
#   2. validate — Zod structural check + LLM quality gates
#   3. relate   — populate related_chunks across all active chunks
#   4. rebuild  — regenerate guide.yaml from front matter (source of truth)
```

### Individual pipeline commands

| Command                    | What it does                                                                                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run extract <source>` | PDF → chunk .md files + updates guide.yaml. Accepts file, directory, or multiple paths.                                                                     |
| `bun run validate`         | Phase 1: Zod structural check on all active chunks. Phase 2: LLM quality gates (Clarity, Consistency, Completeness). Marks failing chunks `status: review`. |
| `bun run relate`           | Uses LLM to find related chunks across the KB. Writes `related_chunks` into each chunk's front matter. Re-run whenever new chunks are added.                |
| `bun run rebuild`          | Rebuilds guide.yaml from scratch by reading all chunk .md front matter. Run after any manual chunk edits.                                                   |
| `bun run validate-guide`   | Fast Zod structural check against guide.yaml entries. No LLM calls. Run before serving to confirm the index is well-formed.                                 |
| `bun run e2e-test`         | Structural end-to-end test: file system integrity, schema validation, section checks, format normalisation. No LLM calls. Runs in seconds.                  |
| `bun run delete`           | Remove a chunk from chunks/ and guide.yaml by chunk_id.                                                                                                     |
| `bun run server`           | Start the Hono HTTP API server.                                                                                                                             |
| `bun run chat`             | Interactive CLI chat against the knowledge base.                                                                                                            |

### Content operations

| Operation                 | Steps                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------- |
| **Add new PDF**           | `bun run ingest ./new-doc.pdf`                                                      |
| **Update existing PDF**   | Delete old `.md` file(s) for that source, re-run `bun run ingest ./updated-doc.pdf` |
| **Delete a chunk**        | `bun run delete <chunk_id>`, then `bun run rebuild`                                 |
| **Re-link relationships** | `bun run relate && bun run rebuild`                                                 |
| **Verify KB health**      | `bun run e2e-test && bun run validate-guide`                                        |

---

## Ingestion Workflow Checklist

Follow this checklist every time you add or update documents:

```
[ ] 1. Place PDF(s) in a known location
[ ] 2. Run: bun run ingest ./path/to/file.pdf
[ ] 3. Review extract output — check chunk count and chunk_ids make sense
[ ] 4. Review validate output — all chunks should pass Phase 1 (Zod) and Phase 2 (LLM)
[ ]    If any chunk fails, inspect data/chunks/<chunk_id>.md and fix the issue manually,
[ ]    then re-run: bun run validate
[ ] 5. Review relate output — confirm related_chunks are populated
[ ] 6. Run: bun run e2e-test — all checks should pass
[ ] 7. Run: bun run validate-guide — all guide entries should be valid
[ ] 8. Start server: bun run server
[ ] 9. Test: curl -X POST http://localhost:3000/api/chat \
         -H "Content-Type: application/json" \
         -d '{"message":"<question about the new content>","sessionId":"test"}'
```

---

## Environment Variables

All variables are set in `.env`. Copy `.env.example` to get started:

```bash
cp .env.example .env
```

| Variable                       | Required                | Description                                          |
| ------------------------------ | ----------------------- | ---------------------------------------------------- |
| `AI_PROVIDER`                  | ✅                      | Active provider: `openai`, `azure`, `google`, `groq` |
| `OPENAI_API_KEY`               | If `AI_PROVIDER=openai` | OpenAI API key                                       |
| `AZURE_RESOURCE_NAME`          | If `AI_PROVIDER=azure`  | Azure OpenAI resource name (not full URL)            |
| `AZURE_API_KEY`                | If `AI_PROVIDER=azure`  | Azure OpenAI key                                     |
| `AZURE_DEPLOYMENT`             | If `AI_PROVIDER=azure`  | Deployment name (e.g. `gpt-4o`)                      |
| `GOOGLE_GENERATIVE_AI_API_KEY` | If `AI_PROVIDER=google` | Google AI Studio key                                 |
| `GROQ_API_KEY`                 | If `AI_PROVIDER=groq`   | Groq API key                                         |
| `MODEL_OVERRIDE`               | ❌ optional             | Override the default model for the active provider   |
| `PORT`                         | ❌ optional             | HTTP server port (default: `3000`)                   |

---

## Troubleshooting

### `bun run ingest` fails at extract step

**Symptom:** "No chunks extracted" or LLM returns empty array.

**Causes and fixes:**

- PDF is encrypted or image-only (needs OCR) → Ensure PDF has selectable text
- LLM API key is not set → Check your `.env` file, confirm `AI_PROVIDER` and corresponding key are set
- PDF is too large (>4MB) → Split the PDF into smaller sections before ingesting

### `bun run validate` marks chunks as `review`

**Symptom:** Chunks fail Phase 1 Zod structural check.

**Fix:** Inspect the reported chunk file in `data/chunks/`, check that:

- YAML front matter has `---` delimiters
- `chunk_id`, `topic`, `summary` fields are present
- `## Context`, `## Response`, `## Escalation` sections exist

If `has_conditions: true`, also verify a `## Conditions` section exists.

### `bun run server` returns stale answers

**Symptom:** Server is running but doesn't reflect newly ingested chunks.

**Cause:** guide.yaml is cached in memory. The cache is only loaded on server start.

**Fix:** Restart the server: `bun run server`

### Chat returns "No relevant documentation found"

**Symptom:** LLM says it has no information but you've ingested the relevant doc.

**Possible causes:**

1. Chunk status is `review` (failed validation) → run `bun run validate` and fix
2. Triggers don't match user phrasing → edit triggers in the chunk `.md` file, re-run `bun run rebuild`
3. related_chunks not populated → run `bun run relate && bun run rebuild`

### `@ai-sdk/azure` module not found

```bash
bun add @ai-sdk/azure
```

### `guide.yaml` out of sync with chunk files

```bash
bun run rebuild    # Regenerates guide.yaml from all .md front matter
```
