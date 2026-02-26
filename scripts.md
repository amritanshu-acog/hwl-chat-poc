# Scripts Quick Reference

All commands run from the project root: `bun run <command>`

---

## Primary Workflows

### `bun run ingest <pdf-file-or-dir>`

- **File:** `src/scripts/ingest.ts`
- **What it does:** Full pipeline in one command — runs `extract → validate → relate → rebuild` in sequence. `extract` and `rebuild` are fatal (pipeline aborts on failure). `validate` and `relate` are non-fatal (pipeline continues with degraded output).
- **Flags:** `--type=qna` switches the extraction prompt for FAQ/Q&A format PDFs
- **When to use:** Every time you add new PDFs to the knowledge base

```bash
bun run ingest ./my-manual.pdf
bun run ingest --type=qna ./faq.pdf
bun run ingest ./docs/procedure/
```

---

### `bun run server`

- **File:** `src/server.ts`
- **What it does:** Starts the Hono HTTP API on `http://localhost:3000`. Exposes:
  - `POST /api/chat` — question-answering endpoint
  - `GET /api/health` — server status and circuit breaker state
  - `GET /api/chunks` — list all chunks from `guide.yaml`
- **Production features:** Rate limiting (20 req/60s per session), body size guard (64 KB), request timeout (120s), CORS from `CORS_ORIGIN` env var, graceful SIGTERM/SIGINT shutdown, fire-and-forget NDJSON logging, request correlation ID on every response (`X-Request-Id` header)

---

### `bun run chat`

- **File:** `src/main.ts`
- **What it does:** Interactive terminal chat — no server required
- **Flags:** `--debug` prints the exact chunks retrieved before each answer (Evidence Box)

---

## Pipeline Steps (individual)

Use `bun run ingest` instead unless you need to re-run a specific step.

### `bun run extract <pdf-file>`

- **File:** `src/extract.ts`
- **Step:** 1 of 4
- **What it does:** Reads the PDF, chooses extraction strategy by size, calls the LLM, writes `.md` chunk files to `data/chunks/`, updates `source-manifest.json`
- **Strategy:** PDFs < 4 MB → single LLM call. PDFs ≥ 4 MB with text layer → segmented by headings (one LLM call per segment). Image-only PDFs → single-shot fallback.
- **Flags:** `--type=qna` uses the Q&A extraction prompt

### `bun run validate`

- **File:** `src/scripts/validate.ts`
- **Step:** 2 of 4
- **What it does:**
  - Phase 1 (no LLM): Zod schema check on front matter + verifies `## Context`, `## Response`, `## Escalation` sections exist. Failed chunks immediately tagged `status: review`.
  - Phase 2 (LLM): Rates each structurally valid chunk on **Clarity**, **Consistency**, and **Completeness**. Failed chunks tagged `status: review`.
- **Reliability:** Each LLM call uses `callLlmWithRetry` (1 automatic retry, 2s delay). Per-file read errors are skipped, not fatal.

### `bun run relate`

- **File:** `src/scripts/relate.ts`
- **Step:** 3 of 4
- **What it does:** LLM pass to find related chunks and write `related_chunks` into each `.md` front matter. On LLM error, the chunk keeps its existing `related_chunks` (graceful fallback).
- **Reliability:** Each LLM call uses `callLlmWithRetry`. Per-file read errors are skipped.

### `bun run rebuild`

- **File:** `src/scripts/rebuild-guide.ts`
- **Step:** 4 of 4
- **What it does:** Reads all `.md` files in `data/chunks/`, writes `data/guide.yaml` from chunks where `status: active`. Chunks with `status: review` or `status: deprecated` are excluded from the index — their `.md` files are not deleted.
- **When to run manually:** After any direct edits to chunk files or after `bun run delete`

---

## Testing & Evaluation

### `bun run e2e-test` (also `bun run test`)

- **File:** `src/scripts/e2e-test.ts`
- **What it does:** Structural regression tests — verifies `guide.yaml` ↔ `data/chunks/` alignment, Zod schema compliance, required markdown sections, and `related_chunks` format. ~170+ checks. Zero LLM calls, runs in seconds.

### `bun run score`

- **File:** `src/scripts/eval-retrieval.ts`
- **What it does:** Retrieval accuracy evaluation — runs questions from `data/test-queries.json` against the retrieval system and scores how many expected chunk IDs are returned. Requires a gold-standard query set.

---

## Utilities & Maintenance

### `bun run chunk <pdf-file>`

- **File:** `src/scripts/chunk-debug.ts`
- **What it does:** Segments a PDF using the chunker engine and saves each block as a `.txt` to `data/debug-chunks/` — shows exactly what text the LLM will receive, without making any LLM call. Use this when extraction results look wrong.

### `bun run delete <chunk_id>`

- **File:** `src/scripts/delete.ts`
- **What it does:** Deletes `data/chunks/<chunk_id>.md`, then calls `bun run rebuild` to regenerate `guide.yaml`. Never delete chunk files manually — use this command so the index stays in sync.

```bash
bun run delete update-email-preferences-default
```

### `bun run validate-guide`

- **File:** `src/scripts/validate-guide.ts`
- **What it does:** Fast Zod-only structural check on `guide.yaml` entries. No LLM. Runs in under 1 second. Useful as a sanity check after manual edits to `guide.yaml`.

### `bun run perf-report`

- **File:** `src/scripts/perf-report.ts`
- **What it does:** Reads historical ingestion reports from `data/reports/` and prints average duration per pipeline step across all runs.
