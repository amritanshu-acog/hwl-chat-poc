# PDF Ingestion Pipeline — Technical Update

> **Scope:** Files < 2 MB · Procedure extraction only (Q&A prompt exists, untested) · No image extraction

---

## 1. Single Entry Point

```
bun run ingest <file.pdf>
```

`ingest.ts` is the orchestrator. It runs four steps in sequence using `execFileSync`:

```
extract → validate → relate → rebuild
```

Each step is a separate Bun script. If **extract** fails, the pipeline aborts immediately. If **validate** or **relate** fail, the pipeline logs a warning and continues. If **rebuild** fails, the pipeline aborts (guide.yaml would be stale).

At the end, a structured JSON report is written to `data/reports/ingest-<timestamp>.json`.

---

## 2. Pipeline Steps

### Step 1 — Extract (`src/extract.ts`)

**What it does:**

- Reads the PDF as a binary buffer, base64-encodes it.
- Checks `source-manifest.json` — if the SHA-256 hash of the PDF matches the stored hash, extraction is **skipped** (idempotent).
- If the file is **< 2 MB**, sends the entire base64-encoded PDF directly to the LLM in a single call (called `fallbackExtract`).
- The LLM reads every page including images. **There is no separate image extraction step** — the LLM writes the `context` field by reading the image and describing it inline.
- The LLM returns a raw JSON array of chunk objects.
- Each chunk is Zod-validated against `LLMChunkOutputSchema` before being saved.
- Valid chunks are written as `.md` files to `data/chunks/`.
- `guide.yaml` is updated with each chunk's front matter.
- `source-manifest.json` is updated with the PDF hash, extraction timestamp, and produced `chunk_ids`.

**LLM call:**

- Model: configured via `providers.ts` (env-driven).
- System prompt: `src/prompts/extraction.md` (the procedure extraction prompt).
- User message: instructs the LLM to return `chunk_id`, `topic`, `summary`, `triggers`, `has_conditions`, `related_chunks`, `status`, `context`, `response` (and optionally `conditions`, `constraints`) as a raw JSON array — no markdown fences.
- `maxOutputTokens: 16000`.

**Error handling in extract:**
| Situation | Behaviour |
|---|---|
| Auth / token-limit error | Aborts immediately — no retry |
| Rate-limit / transient (5xx) | Exponential backoff with ±20% jitter, up to 2 retries |
| LLM returns invalid JSON | Raw output saved to `data/reports/llm-raw-debug-<ts>.txt`; retry attempted |
| `has_conditions: true` but no `conditions` field | Chunk status auto-set to `review` before saving |
| Individual chunk fails Zod | Logged, skipped — remaining chunks are still saved |
| PDF file unreadable | Logged; that source is counted as failed; pipeline continues to next PDF |

**Circuit breaker (shared across all LLM calls):**

- Threshold: 5 consecutive failures → breaker **OPEN**.
- While OPEN: all LLM calls fail immediately with an error (no network call made).
- After 60 s (configurable): breaker moves to **HALF_OPEN**, one probe request is sent. Success → **CLOSED**. Failure → back to **OPEN**.

---

### Step 2 — Validate (`src/scripts/validate.ts`)

**No LLM call.** Pure structural check only.

**What Zod checks (`ChunkFrontMatterSchema`):**
| Field | Rule |
|---|---|
| `chunk_id` | Non-empty string, regex `/^[a-z0-9-]+$/` (lowercase-hyphenated only) |
| `source` | Non-empty string |
| `topic` | Non-empty string |
| `summary` | Non-empty string |
| `triggers` | Array of strings (can be empty) |
| `has_conditions` | Boolean |
| `related_chunks` | Array of strings (can be empty) |
| `status` | Enum: `active`, `review`, or `deprecated` |

**Additionally checks:**

- `## Context` section present in the markdown body.
- `## Response` section present in the markdown body.
- If `has_conditions: true`, then `### Conditions` section must also be present.

**On failure:**

- The chunk's `status` field is rewritten to `review` in-place.
- Chunks with `status: review` are **excluded from retrieval** at runtime.
- If any chunks failed, `bun run rebuild` is triggered automatically to sync `guide.yaml`.
- Validate exits with code 0 (non-fatal to the parent `ingest` pipeline).

---

### Step 3 — Relate (`src/scripts/relate.ts`)

**One LLM call.**

**What it does:**

- Reads `guide.yaml`, filters to `status: active` chunks only.
- Sends all chunk `chunk_id`, `topic`, and `summary` fields to the LLM in a single prompt.
- LLM returns clusters: a JSON array of arrays of `chunk_id` strings — groups of 2–4 chunks that a user dealing with one would likely also need.
- Each chunk's `.md` front matter is updated: `related_chunks` is rewritten with the other members of its cluster.

**LLM call:**  
Inline prompt (no `.md` prompt file). Instructs the LLM to return only a raw JSON array of arrays — no explanation.

**Error handling:**
| Situation | Behaviour |
|---|---|
| LLM call fails | Logged; returns empty clusters; no `.md` files updated |
| LLM returns unparseable JSON | Logged; no update applied |
| Chunk `.md` file missing | Skipped with a warning; other chunks still updated |

---

### Step 4 — Rebuild (`src/scripts/rebuild-guide.ts`)

**No LLM call.**

**What it does:**

- Reads every `.md` file in `data/chunks/`.
- Parses the YAML front matter of each file using regex.
- Discards any chunks where `status` is not `active`.
- Writes a fresh `data/guide.yaml` from scratch — **chunk `.md` files are the source of truth**, not `guide.yaml`.
- Warns if `guide.yaml` exceeds 30,000 characters (retrieval accuracy risk).
- Also warns if active chunk count exceeds 80 (recommendation: migrate to embedding-based retrieval).

**Error handling:**

- If `data/chunks/` is unreadable → exits with code 1 (fatal — parent `ingest` aborts).
- If an individual `.md` file is unreadable → skipped with a warning; others are still processed.
- Missing `chunk_id` or `topic` → chunk skipped.

---

## 3. Schemas

### `ChunkFrontMatterSchema` — front matter of each `.md` chunk file

```typescript
chunk_id:        string   // lowercase-hyphenated, e.g. "manage-timecards-a1b2c3d4"
source:          string   // PDF filename
topic:           string   // human-readable topic name
summary:         string   // one-line description
triggers:        string[] // phrases that would make this chunk relevant
has_conditions:  boolean  // true if there are conditional sub-paths
related_chunks:  string[] // populated by the relate step
status:          "active" | "review" | "deprecated"
```

### `LLMChunkOutputSchema` — what the LLM must return in Step 1

All of the above plus:

```typescript
context:     string   // always required — background + image descriptions
conditions?: string   // required only when has_conditions: true
constraints?: string  // optional — hard system limits
response:    string   // always required — the actual answer / steps
```

### `GuideEntrySchema` — one entry inside `guide.yaml`

Same fields as `ChunkFrontMatterSchema`. `guide.yaml` is a flat YAML list of these entries — rebuilt from chunk files every run.

### `source-manifest.json` — per-PDF provenance record

```json
{
  "/absolute/path/to/file.pdf": {
    "hash": "<sha256>",
    "extracted_at": "<ISO timestamp>",
    "chunk_ids": ["chunk-id-one", "chunk-id-two"],
    "size_bytes": 230530
  }
}
```

Used for: deduplication (skip unchanged PDFs), stale chunk cleanup (when a PDF changes, old chunks are deleted before re-extraction), and source attribution at runtime.

---

## 4. Extraction Type Flags

```
bun run ingest --type=procedure <file.pdf>   ← default; uses extraction.md prompt
bun run ingest --type=qna <file.pdf>         ← uses qna-extraction.md prompt (untested)
bun run ingest --type=chat <file.pdf>        ← stub only (future HubSpot)
```

The flag is forwarded from `ingest.ts` to `extract.ts`. The system prompt loaded by the LLM client changes accordingly.

---

## 5. Logging

**Winston** with two transports:

| Transport      | Format                          | Purpose                                           |
| -------------- | ------------------------------- | ------------------------------------------------- |
| Console        | Colourised, human-readable      | Development / CI output                           |
| `logs/app.log` | Newline-delimited JSON (NDJSON) | ELK-compatible; Logstash → Elasticsearch → Kibana |

Every log line includes: `timestamp`, `level`, `service: hwl-ingestion-pipeline`, `message`, and any structured metadata fields (e.g. `source`, `chunkId`, `durationMs`).

HTTP requests that arrive at the server also carry a `reqId` (short random ID). All logger calls within the lifetime of one request automatically include that `reqId` via `AsyncLocalStorage`.

Log rotation: up to 5 rolling files, 10 MB each. `LOG_LEVEL` env var controls verbosity (default: `info`).

---

## 6. Server (`src/server.ts`)

Separate Hono HTTP server; started independently with `bun run server`.

**Its own request log:** `data/logs/requests.ndjson` — one JSON line per chat request.

```json
{
  "reqId": "a1b2c3d4",
  "timestamp": "2026-02-27T...",
  "sessionId": "...",
  "mode": "answer",
  "question": "...",
  "responseEnvelope": { ... },
  "durationMs": 1234
}
```

**Guards in place:**

- Body size limit: 64 KB (configurable).
- Rate limit: 20 requests per session per 60 s (sliding window, in-memory).
- Request timeout: 120 s — after which a `504` is returned.
- Session TTL: 30 min; stale sessions pruned every 5 min.
- Graceful shutdown on `SIGTERM` / `SIGINT` with 5 s drain window.
- Circuit breaker (shared with extraction LLM calls).

---

## 7. Ingest Report

At the end of every `bun run ingest` run, a JSON file is written to `data/reports/ingest-<timestamp>.json`:

```json
{
  "startedAt": "<ISO>",
  "sources": ["file.pdf"],
  "steps": [
    {
      "step": "extract",
      "success": true,
      "durationMs": 12000,
      "output": "",
      "error": null
    },
    { "step": "validate", "success": true, "durationMs": 300 },
    { "step": "relate", "success": true, "durationMs": 4000 },
    { "step": "rebuild", "success": true, "durationMs": 200 }
  ],
  "chunksInKB": 21,
  "totalDurationMs": 16500,
  "success": true
}
```

---

## 8. Known Limitations / Gaps

| Item                          | Status                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------- |
| Image extraction              | Not implemented. LLM reads images and writes context summary inline.                        |
| Q&A extraction (`--type=qna`) | Prompt exists (`qna-extraction.md`). Not tested end-to-end.                                 |
| Files > 2 MB                  | Handled by segmentation path (chunker); out of current scope.                               |
| Embedding-based retrieval     | Not yet. Guide YAML sent whole to LLM for retrieval. Warning fires at >80 chunks or >30 KB. |
| Multi-instance rate limiting  | In-memory only. Needs Redis for horizontal scaling.                                         |
