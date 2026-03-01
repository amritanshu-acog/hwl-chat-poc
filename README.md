# HWL Troubleshooting Assistant

An LLM-powered helpdesk assistant that extracts knowledge from PDFs and deterministically answers user questions based **only** on that indexed knowledge.

## 🚀 Quick Start

1. `cp .env.example .env` (Add your LLM API keys)
2. `bun install`
3. `bun run ingest <path/to/pdf>` (Extracts, validates, and indexes your document)
4. `bun run server` (Starts API on `localhost:3000`)
5. `bun run chat` (Interactive terminal testing)

## 🧠 Architecture Overview

- **Offline (Ingestion)**: PDFs → `bun run ingest` → Markdown chunks in `/chunks` + `guide.yaml` index.
- **Online (Chat)**: User query → AI retrieves 2-3 specific chunks → AI generates a strict JSON UI response based _only_ on those chunks.

## 💻 Core Commands

- `bun run ingest [--type=qna] <path>` — The full pipeline: extracts, validates, relates, and rebuilds the index. (Use `--type=qna` for FAQ-style documents).
- `bun run server` — Runs the HTTP API server.
- `bun run chat [--debug]` — CLI chat (use `--debug` to see the exact evidence chunks the AI read).
- `bun run score` — Evaluates retrieval accuracy against `data/test-queries.json`.
- `bun run test` — Instant structural integrity regression check of the knowledge base.
- `bun run chunk <pdf>` — Debug tool to visually preview how a PDF is chunked before LLM extraction.

## 🔌 API Integration (`POST /api/chat`)

Send questions to the system to get typed JSON components (UI elements) and file citations back:

```json
// Request
{
  "message": "How do I reset my password?",
  "sessionId": "user-123"
}

// Response
{
  "response": {
    "type": "steps",
    "data": { "title": "Reset Password", "steps": [...] }
  },
  "contextChunks": [
    {
       "chunk_id": "hwl-agency-password-reset",
       "topic": "Password Management",
       "file": "HWL Agency_Staff Pool V3.pdf"
    }
  ]
}
```
