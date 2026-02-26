# HELP.md — What This Project Is and How to Use It

---

## What This Project Does

This is a **knowledge-base chatbot** for a helpdesk product (HWL Agency platform).

The system has two modes:

**1. Offline (ingestion) — you run this manually:**
You give it PDF documents (user manuals, how-to guides, FAQ sheets).
It reads them with an LLM, extracts every piece of knowledge into small structured files called "chunks", and builds an index file called `guide.yaml`.

**2. Online (chat) — runs as a server:**
When a user asks a question, the system:

1. Looks at `guide.yaml` to find the 2–3 most relevant chunks
2. Loads those chunk files from disk
3. Feeds them to the LLM along with the question
4. Returns a structured JSON answer (steps, alerts, choices, etc.)

**The golden rule:** The LLM can ONLY answer from what is in the knowledge base. It cannot make things up from general knowledge. If it's not in a chunk, the bot says it doesn't know.

---

## The Files on Disk

```
troubleshooting-poc/
│
├── data/
│   ├── guide.yaml          ← The index. Lists every chunk: topic, summary, triggers, file path.
│   ├── test-queries.json   ← "Gold Standard" test queries and expected chunks for evaluation
│   └── chunks/             ← One .md file per knowledge chunk. This is the actual knowledge.
│       ├── timecard-invoices-process.md
│       ├── email-notification-preferences.md
│       └── ... (21 chunks currently)
│
├── src/
│   ├── extract.ts          ← Reads PDFs, calls LLM, writes chunk .md files + guide.yaml
│   ├── llm-client.ts       ← All LLM calls — circuit breaker, error classification, backoff
│   ├── server.ts           ← Hono HTTP API — rate limiting, timeout, graceful shutdown
│   ├── main.ts             ← Interactive CLI chat (type questions in terminal)
│   ├── config.ts           ← Centralized pipeline + server configuration (all env var defaults)
│   ├── schemas.ts          ← Zod type definitions for chunks, guide entries, LLM output
│   ├── providers.ts        ← Provider registry (Azure / Google / Groq)
│   ├── chunker.ts          ← Deterministic heading-based document segmentation engine
│   ├── logger.ts           ← Winston logger with AsyncLocalStorage request correlation
│   │
│   ├── prompts/
│   │   ├── extraction.md      ← System prompt for procedure PDFs
│   │   ├── qna-extraction.md  ← System prompt for FAQ/Q&A PDFs
│   │   ├── chat-extraction.md ← System prompt for chat log extraction (future)
│   │   └── chat.md            ← System prompt for answering user questions
│   │
│   └── scripts/
│       ├── ingest.ts          ← Full pipeline orchestrator (extract → validate → relate → rebuild)
│       ├── validate.ts        ← Quality check: Zod structure + LLM Clarity/Consistency/Completeness
│       ├── relate.ts          ← Find related chunks and wire them together
│       ├── rebuild-guide.ts   ← Rebuild guide.yaml from active chunk front matter
│       ├── validate-guide.ts  ← Fast Zod-only check on guide.yaml structure
│       ├── perf-report.ts     ← Aggregate timing metrics from ingestion reports
│       ├── e2e-test.ts        ← Structural regression tests (no LLM, runs in seconds)
│       ├── eval-retrieval.ts  ← Retrieval accuracy evaluation (requires test-queries.json)
│       ├── source-manifest.ts ← Track which PDF produced which chunks
│       ├── chunk-debug.ts     ← PDF segmentation preview (no LLM)
│       └── delete.ts          ← Remove a chunk from the KB and resync guide.yaml
│
├── source-manifest.json    ← Created at runtime. Maps PDF → chunk_ids + hash
├── package.json            ← All runnable commands are here
├── .env                    ← Your API keys (copy from .env.example)
├── .env.example            ← All supported environment variables with defaults
└── HELP.md                 ← This file
```

---

## All Commands — What to Run and What to Expect

### 1. `bun run ingest <pdf-file-or-directory>`

**What it does:** Full pipeline in one command. Runs all 4 steps below in order.
**When to use:** Every time you add new PDFs to the knowledge base.

**Flags:**

- `--type=qna`: If the PDF you are ingesting is an FAQ layout instead of a User Manual, pass this flag so it alters the underlying prompt for better extraction quality.

```bash
bun run ingest ./my-manual.pdf
bun run ingest --type=qna ./faq.pdf # Use for Q&A documents
bun run ingest ./docs/             # all PDFs in a folder
bun run ingest a.pdf b.pdf         # multiple files
```

**Expected output:**

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  🚀 HWL Knowledge Base — Ingestion Orchestrator
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📋 Sources queued for ingestion:
   • my-manual.pdf
   Total: 1 PDF(s)

[1/4] Extract — PDF → chunks + guide.yaml
  ✓ Created: some-topic.md
  ✓ Created: another-topic.md

[2/4] Validate — Zod structural + LLM quality gates
  ✅ some-topic.md — structure OK
  ✅ another-topic.md — structure OK

[3/4] Relate — populate related_chunks across KB
  Relating some-topic... ✓ [another-topic]

[4/4] Rebuild — regenerate guide.yaml from chunk front matter

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✅ Ingestion Complete
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Started at:    2026-02-24T...
  Total time:    45.2s
  Sources:       1 PDF(s)
  Active chunks: 23

  Step Results:
    ✅ extract   42.1s
    ✅ validate   8.3s
    ✅ relate     3.1s
    ✅ rebuild    0.2s

  Knowledge base is ready. Start the server with:
    bun run server
```

---

### 2. `bun run extract [--type=qna] <pdf-file-or-directory>`

**What it does:** Step 1 only. Reads the PDF, calls the LLM to extract knowledge chunks, writes `.md` files to `data/chunks/`. Updates `source-manifest.json`.
**When to use:** If you only want extraction without validation (rare). Passing `--type=qna` uses a specialized prompt for Q&A documents instead of standard procedures.

```bash
bun run extract ./my-manual.pdf
bun run extract --type=qna ./my-faq.pdf
```

**Expected output:**

```
🚀 Starting extraction for 1 source(s)...

━━━ [1/1] my-manual.pdf ━━━

📄 Reading PDF: /path/to/my-manual.pdf
  ↳ PDF size: 420.3 KB

⏱  LLM extraction [my-manual.pdf]: 38.2s
  ✓ Created: some-topic.md
    Topic:   Timecards
    Summary: How to submit a timecard in HWL Agency
    Triggers: 3
    Images:  2
    Conditions: false

📋 source-manifest.json updated

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 Extraction Summary
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Sources processed : 1
   Chunks created    : 3
   Chunks updated    : 0
   Sources failed    : 0
   Total time        : 38.4s
   Output directory  : /path/to/data/chunks
   Guide index       : data/guide.yaml
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Next steps:
  1. Validate chunks:  bun run validate
  2. Link related:     bun run relate
  3. Rebuild index:    bun run rebuild
  — or run all steps: bun run ingest <sources>
```

---

### 3. `bun run validate`

**What it does:** Two-phase quality check on all active chunks.

- **Phase 1 (instant, no LLM):** Checks that each `.md` file has valid YAML front matter, all required fields (`chunk_id`, `topic`, `summary`, `triggers`, etc.), and the required markdown sections (`## Context`, `## Response`, `## Escalation`). Marks bad chunks `status: review` immediately — no LLM call wasted.
- **Phase 2 (LLM):** Checks **Clarity**, **Consistency**, and **Completeness** of each structurally valid chunk. Uses `callLlmWithRetry` — one automatic retry on transient errors before marking for review.

```bash
bun run validate
```

**Expected output:**

```
🔍 Validating chunks (Phase 1: Structural · Phase 2: LLM Quality)...

Phase 1 — Zod structural check: front-matter schema + required sections
Phase 2 — LLM quality gates:    Clarity · Consistency · Completeness

━━━ Phase 1: Structural Validation ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ✅ timecard-invoices-process.md — structure OK
  ✅ email-notification-preferences.md — structure OK
  ...

  Structural: 21 passed, 0 failed

━━━ Phase 2: LLM Quality Gates ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📂 Sending 21 structurally valid active chunk(s) to LLM...

  ✅ timecard-invoices-process        Clarity ✓  Consistency ✓  Completeness ✓
  ✅ email-notification-preferences   Clarity ✓  Consistency ✓  Completeness ✓
  ...

✅ Validation complete — 21 passed, 0 failed
```

**If a chunk fails Phase 1:**

```
  ❌ some-chunk.md — structural FAIL
       • front-matter.summary: Required
       • Missing required markdown section: "## Response"
       → Marked as status: review (structural failure)
```

---

### 4. `bun run relate`

**What it does:** Asks the LLM to find which chunks are related to each other. Writes the relationships into each chunk's `related_chunks` front matter field. This helps the chat system find relevant context even when the exact match isn't obvious.

```bash
bun run relate
```

**Expected output:**

```
🔗 Running post-aggregation related chunks pass...

📂 Processing 21 active chunk(s)...

  Relating timecard-invoices-process... ✓ [expense-invoices-process]
  Relating email-notification-preferences... ✓ [update-email-preferences-default-selection, update-email-preferences-manual-selection]
  ...

✅ Related chunks written for 21 chunk(s)

🔨 Rebuilding guide.yaml...
✅ Done.
```

---

### 5. `bun run rebuild`

**What it does:** Reads every `.md` file in `data/chunks/`, extracts the YAML front matter from each **active** chunk, and regenerates `guide.yaml` from scratch for retrieval. It intentionally ignores chunks marked as "review" or "deprecated". Use this any time you edit chunk files manually or after deletions.

```bash
bun run rebuild
```

**Expected output:**

```
🔨 Rebuilding guide.yaml from 21 active chunk(s)...
✅ guide.yaml rebuilt.
```

---

### 6. `bun run validate-guide`

**What it does:** Fast structural check — reads `guide.yaml` and validates every entry against the GuideEntry schema using Zod. No LLM calls. Runs in under 1 second.

```bash
bun run validate-guide
```

**Expected output (all pass):**

```
🔍 Validating guide.yaml against GuideEntrySchema...

📂 Found 21 guide.yaml entry/entries

  ✅ candidate-status-column-buttons
  ✅ dashboard-detailed-view
  ✅ email-notification-preferences
  ...

📊 guide.yaml Validation Summary
   Entries checked: 21
   Passed:          21
   Failed:          0

✅ All guide.yaml entries are structurally valid.
```

---

### 7. `bun run perf-report`

**What it does:** Reads structured ingestion reports from `data/reports/` and aggregates metrics, providing an average duration summary for each pipeline step across runs.

```bash
bun run perf-report
```

**Expected output:**

```
📊 HWL Ingestion Performance Report
════════════════════════════════════════
  Processed Runs:  1
  Total Sources:   1
  Avg Run Time:    116.7s

  Average Time per Step:
    • extract         100.9s
    • validate        10.1s
...
```

---

### 8. `bun run e2e-test` (also `bun run test`)

**What it does:** Full structural regression test. Checks that:

- `guide.yaml` exists and has entries
- Every guide entry has a matching `.md` file on disk
- Every `.md` file has a guide entry
- Every chunk passes the front-matter Zod schema
- Every chunk has `## Context`, `## Response`, `## Escalation` sections
- No chunks have the old `chunk_id:` prefix bug in `related_chunks`
- Every guide.yaml entry passes GuideEntrySchema

No LLM calls. Runs in under 3 seconds.

```bash
bun run e2e-test
```

**Expected output (healthy KB):**

```
🧪 HWL Knowledge Base — End-to-End Structural Tests

═══════════════════════════════════════════════════════

📁 Test: File System Integrity
  ✅ guide.yaml exists
  ✅ data/chunks/ directory exists

📋 Test: guide.yaml ↔ Filesystem Consistency
  ✅ guide.yaml has at least 1 entry
  ✅ data/chunks/ has at least 1 .md file
  ✅ guide entry 'timecard-invoices-process' has .md file
  ...

🔍 Test: Chunk Front-Matter Schema Validation
  ✅ timecard-invoices-process.md front-matter schema
  ...

📄 Test: Required Markdown Sections
  ✅ timecard-invoices-process.md has ## Context
  ✅ timecard-invoices-process.md has ## Response
  ✅ timecard-invoices-process.md has ## Escalation
  ...

🔗 Test: related_chunks Format Normalisation (GAP-D1-05)
  ✅ timecard-invoices-process.md has no 'chunk_id:' prefix in related_chunks
  ...

📊 E2E Test Results
   Total:   172
   Passed:  172
   Failed:  0

✅ All structural invariants pass.
```

---

### 9. `bun run server`

**What it does:** Starts the HTTP API server on port 3000 (or `PORT` env var).

```bash
bun run server
```

**Expected output:**

```
🚀 Server ready — 21 chunks in guide.yaml

🌐 Listening on http://localhost:3000
📝 Logging to data/logs/requests.ndjson
🔒 CORS origin: http://localhost:5173
⏱  Request timeout: 120s
🚦 Rate limit: 20 req / 60s per session
```

**Routes:**

```
GET  /api/health   — server status and chunk count
GET  /api/chunks   — list all chunks from guide.yaml
POST /api/chat     — question-answering endpoint
```

**Test it:**

```bash
# Health check
curl http://localhost:3000/api/health

# Ask a question
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "How do I submit a timecard?", "sessionId": "test123"}'
```

**Chat response shape:**

```json
{
  "response": {
    "type": "steps",
    "data": {
      "title": "How to submit a timecard",
      "steps": [{ "title": "Step 1", "body": "..." }]
    }
  },
  "contextChunks": [
    {
      "chunk_id": "timecard-invoices-process-a1b2c3d4",
      "topic": "Timecard Submission",
      "file": "HWL Agency Manual.pdf"
    }
  ]
}
```

The `X-Request-Id` response header carries a short ID that correlates all server logs for this request.

---

### 10. `bun run chat`

**What it does:** Interactive terminal chat. Type questions, get answers. No server needed.

**Flags:**

- `--debug`: Activates "Developer Mode". Before rendering the final answer, it prints out the precise `chunk_id`s, `topic`s, and chunk contents that the AI successfully retrieved during its search phase. Critical for debugging retrieval failures.

```bash
bun run chat
bun run chat --debug
```

**Expected output (Standard):**

```
💬 HWL Assistant — type your question (or 'exit')

You: How do I reset my password?
Assistant: [structured answer from knowledge base]

You: exit
```

**Expected output (with `--debug` flag):**

```
You: How do I reset my password?
Assistant:
🔍 Calling LLM...
🔍 Step 1 — Retrieval: finding relevant chunks from guide...

══════════════════════════════════════════════════════════════
🔍 [DEBUG] EVIDENCE: The AI is reading the following chunks
══════════════════════════════════════════════════════════════

📋 Chunk 1 of 2
   ID:      hwl-agency-password-reset
   Topic:   Password Reset Procedure
   ...
```

---

### 11. `bun run delete`

**What it does:** Removes a chunk by chunk_id from both `data/chunks/` and `guide.yaml`.

```bash
bun run delete timecard-invoices-process
```

**Expected output:**

```
🗑️  Deleting chunk: timecard-invoices-process
  ✅ Removed: data/chunks/timecard-invoices-process.md
  ✅ Removed from guide.yaml
```

---

### 12. `bun run score`

**What it does:** Runs the automated retrieval accuracy evaluation script (`eval-retrieval.ts`). It loads the "Gold Standard" list of test questions from `data/test-queries.json` and checks if the AI's retrieval engine successfully pulls the expected chunk ID for every question.

**When to use:** Crucial for regression testing. Run this before client demos or whenever you drastically alter the chunk triggers/summaries to ensure you aren't hurting overall search accuracy.

```bash
bun run score
```

**Expected output:**

```
📊 Retrieval Accuracy Score: 100% (5/5)

Full details saved to: data/reports/eval-report-2026-02-24T...
```

---

## Design Principles

1. **The LLM decides the knowledge, not the developer.** You give it a PDF and it extracts what it thinks is important. You don't write the chunks by hand.

2. **`guide.yaml` is the index, `.md` files are the truth.** `guide.yaml` is generated from the `.md` files — so if they disagree, run `bun run rebuild` to fix it.

3. **Chunks are self-contained.** A user reading one chunk must be able to understand it completely without reading any other chunk. This is enforced by the extraction prompt.

4. **The system only knows what's in the PDFs.** If a user asks about something not in any chunk, the bot returns an escalation response. It never invents an answer.

5. **Q&A format PDFs are different from procedure PDFs.** Procedure PDFs = how-to guides and step-by-step instructions. Q&A PDFs = FAQ documents. Use `--type=qna` during extraction to apply the specialized prompt.

6. **Reliability is layered.** Every LLM call goes through the circuit breaker → classified error → exponential backoff + jitter. File reads in pipeline loops are individually guarded. The server rate-limits, enforces a body size cap, and times out hangs.

---

## Quick Start (from zero)

```bash
# 1. Copy env file and fill in your API key
cp .env.example .env
# Edit .env: set AI_PROVIDER=google (or azure/groq) and the matching API key

# 2. Install dependencies
bun install

# 3. Ingest a PDF
bun run ingest ./your-manual.pdf

# 4. Verify everything is healthy
bun run e2e-test

# 5. Start the server
bun run server

# 6. Test a question
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "How do I submit a timecard?", "sessionId": "s1"}'
```
