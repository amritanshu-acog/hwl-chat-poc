# Scripts Quick Reference

All commands run from the project root: `bun run <command>`

---

## Chat Server

### `bun run server`

- **File:** `src/api/server.ts`
- **What it does:** Starts the Hono HTTP API on `http://localhost:3000`. Exposes:
  - `POST /api/chat` — question-answering endpoint
  - `GET /api/health` — server status and chunk count
  - `GET /api/chunks` — list all chunks from `guide.yaml`
- **Reads from:** `generation/output/final/`
- **Production features:** Rate limiting (20 req/60s per session), body size guard (64 KB), request timeout (120s), CORS from `CORS_ORIGIN` env var, graceful SIGTERM/SIGINT shutdown, fire-and-forget NDJSON logging, request correlation ID (`X-Request-Id` header)

---

### `bun run chat`

- **File:** `src/cli/chat.ts`
- **What it does:** Interactive terminal chat — no server required. Lists available chunks on startup, accepts questions, returns answers directly in the terminal.
- **Reads from:** `generation/output/final/`

---

## Generation Pipeline

### `bun run gen:run`

- **File:** `generation/src/pipeline/run.ts`
- **What it does:** Full pipeline for both `procedure` and `qna` doc types — runs chunk → quality → compile → archive in sequence. Each doc type is independent. Compile runs once across both.
- **When to use:** Every time you drop new PDFs into input folders

```bash
bun run gen:run
```

---

### `bun run gen:run:procedure`

- **File:** `generation/src/pipeline/run.ts --doc-type=procedure`
- **What it does:** Same as `gen:run` but only processes PDFs in `generation/input/procedure/`
- **When to use:** When you only have new procedure/how-to PDFs to process

---

### `bun run gen:run:qna`

- **File:** `generation/src/pipeline/run.ts --doc-type=qna`
- **What it does:** Same as `gen:run` but only processes PDFs in `generation/input/qna/`
- **When to use:** When you only have new FAQ/Q&A PDFs to process

---

### `bun run gen:generate-rules`

- **File:** `generation/src/pipeline/generate-rules.ts`
- **What it does:** Reads the chunking prompts (`procedure.md`, `qna.md`) and asks the LLM to generate validation rules. Writes `generation/rules/procedure_rules.json` and `generation/rules/qna_rules.json`.
- **When to use:** Once at setup. Re-run only if you edit the chunking prompts.

```bash
bun run gen:generate-rules
```

---

### `bun run gen:delete`

- **File:** `generation/src/pipeline/delete.ts`
- **What it does:** Removes all chunks in `generation/output/final/` that belong to the specified source PDF. Backs up `final/` first, then rebuilds `guide.yaml` and recomputes related chunks after deletion.
- **When to use:** When a PDF is outdated and needs to be fully removed from the knowledge base.

```bash
bun run gen:delete "HWL Agency_Staff Pool V3.pdf"
```

---

## Manual Intervention Commands

Use these when the full pipeline fails partway and you need to re-run a specific stage without reprocessing PDFs.

---

### `bun run gen:quality:procedure`

- **File:** `generation/src/pipeline/quality.ts procedure`
- **What it does:** Re-runs the quality stage on whatever is currently in `generation/output/chunk/procedure/`. Validates all chunks against `procedure_rules.json`. Passes go to `pass/procedure/`, failures go to `fail/procedure/<timestamp>/`.
- **When to use:** After fixing the quality check code and you want to re-validate chunks that previously failed without re-chunking.

---

### `bun run gen:quality:qna`

- **File:** `generation/src/pipeline/quality.ts qna`
- **What it does:** Same as above but for `generation/output/chunk/qna/`

---

### `bun run gen:compile`

- **File:** `generation/src/pipeline/compile.ts`
- **What it does:** Promotes all chunks from `pass/` into `final/`, removes stale chunks for incoming sources, rebuilds `guide.yaml`, and recomputes related chunks. Backs up `final/` before making any changes.
- **When to use:** After running `gen:quality:*` standalone, or when compile failed during a full pipeline run and pass/ still has chunks waiting.

---

### `bun run gen:reembed`

- **File:** `generation/src/pipeline/reembed.ts`
- **What it does:** Recomputes embeddings and related chunks for all chunks already in `final/` without running the full pipeline. Rewrites `guide.yaml` with updated `related_chunks` for every entry.
- **When to use:** When embedding failed (wrong model name, API error) but everything else is already in `final/`. Also use after changing `related_chunks.model` or `related_chunks.threshold` in `config.toml`.

---

## Typical Flows

### Adding new PDFs

```bash
# Drop PDFs into generation/input/procedure/ or generation/input/qna/
bun run gen:run
```

### Quality failed, fix the check, re-validate without re-chunking

```bash
# Fix quality.ts
# Copy failed chunks back to output/chunk/procedure/
bun run gen:quality:procedure
bun run gen:compile
```

### Compile failed, pass/ still has chunks

```bash
# Fix compile.ts
bun run gen:compile
```

### Embeddings failed or model changed

```bash
# Update config.toml related_chunks.model
bun run gen:reembed
```

### Remove a PDF from the knowledge base

```bash
bun run gen:delete "My Document.pdf"
```

### First time setup

```bash
bun install
bun run gen:generate-rules
# Drop PDFs into input folders
bun run gen:run
bun run server
```
