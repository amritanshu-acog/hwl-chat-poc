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

## Content Lifecycle

| Operation  | What happens                                                       |
| ---------- | ------------------------------------------------------------------ |
| **Add**    | Run `bun run extract file.pdf` — new chunks created, guide updated |
| **Update** | Delete the old `.md` file, re-run extract — guide entry replaced   |
| **Delete** | Delete the `.md` file, delete its entry from `guide.yaml`          |
