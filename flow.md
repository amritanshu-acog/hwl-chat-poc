# What Happens When You Run `bun run ingest my.pdf`

---

## Step-by-step, plain English

### 1. `ingest.ts` starts

Resolves your PDF path to an absolute path. Then runs 4 steps in order by calling each script as a child process (`execFileSync`). If `extract` or `rebuild` fail, the pipeline aborts. If `validate` or `relate` fail, the pipeline continues (they are non-fatal — degraded output is better than no output).

---

### 2. `extract.ts` — reads the PDF and calls the LLM

The extraction strategy is chosen automatically based on PDF size and whether a text layer exists:

| Condition                                  | Strategy                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------- |
| PDF **< 4 MB**                             | Full PDF sent to LLM in **one call**                                                  |
| PDF **≥ 4 MB** + text layer                | Decoded by `pdf-parse`, split into segments by headings, **one LLM call per segment** |
| PDF **≥ 4 MB**, image-only (no text layer) | Single-shot fallback — full PDF sent to LLM                                           |

```
extract.ts → readPdf()              ← now protected by try/catch (logs clean error on ENOENT)
           → decodePdfToText()     [chunker.ts]  — pdf-parse extracts plain text
           → segmentDocument()     [chunker.ts]  — splits by heading patterns into segments
           → extractFromSegments() [extract.ts]  — calls LLM once per segment
               └─ for each segment:
                     extractChunksFromDocument()  [llm-client.ts]  ← 1 LLM call
                         └─ breakerCall()         ← circuit breaker wraps the call
                         └─ classifyLlmError()    ← auth/rate_limit/token_limit/transient
                         └─ sleep(attempt)        ← exponential backoff + jitter on retry
                     deriveChunkId()              [chunker.ts]  ← stable ID from content hash
           → assembleChunkMarkdown() → writeFile(data/chunks/<id>.md)
           → saveGuide()             → writes data/guide.yaml
           → recordExtraction()      → writes source-manifest.json
```

**LLM calls in this step:** 1 per segment (or 1 total for small/image-only PDFs)

---

### 3. `validate.ts` — quality check on every chunk

```
validate.ts → reads all active .md files
               └─ try/catch per file — a corrupted file is skipped, not fatal
            → Zod schema check on front matter (no LLM, instant)
                        + required sections: ## Context, ## Response
                        → failed chunks → status: review immediately
```

**LLM calls in this step:** 0

---

### 4. `relate.ts` — links related chunks

```
relate.ts → reads all active .md files
              └─ try/catch per file — a corrupted file is skipped, not fatal
          → 1 LLM call per active chunk via callLlmWithRetry()
              └─ asks "which other chunks are related to this one?"
              └─ 1 automatic retry (2s delay) on transient errors
              └─ on failure → returns [] (chunk keeps its existing related_chunks)
          → writes related_chunks into each .md front-matter
          → calls rebuild-guide.ts to sync guide.yaml
```

**LLM calls in this step:** up to 1 per active chunk

---

### 5. `rebuild-guide.ts` — regenerates guide.yaml

```
rebuild-guide.ts → reads every .md file in data/chunks/
                    └─ try/catch per file — a corrupted file is skipped and counted
                 → writes guide.yaml from all chunks where status === "active"
                 → chunks with status: review or deprecated are excluded from the index
                 → the .md files themselves are NOT deleted
```

**LLM calls in this step:** 0

---

## Total LLM calls for 1 PDF

| Step                       | Calls            |
| -------------------------- | ---------------- |
| Extract (N segments)       | N                |
| Validate (M active chunks) | up to M          |
| Relate (M active chunks)   | up to M          |
| **Total**                  | **N + up to 2M** |

Calls are lower than the max when chunks fail Phase 1 validation (no LLM call attempted) or when LLM errors trigger the fail-safe return path.

---

## Output files after ingestion

```
data/
├── guide.yaml              ← index of all active chunks (chunk_id, topic, triggers, file path)
├── chunks/
│   ├── add-candidate-to-staff-pool-<hash>.md
│   ├── upload-proposal-documents-<hash>.md
│   └── ...
├── reports/
│   └── ingest-<timestamp>.json  ← timing and step results for this run
└── logs/requests.ndjson    ← per-request log (server only)

source-manifest.json        ← which PDF produced which chunk_ids (for deduplication)
```

---

## Files involved

| File                             | What it does                                                                        |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| `src/scripts/ingest.ts`          | Orchestrator — runs all 4 scripts in sequence via child process                     |
| `src/extract.ts`                 | Reads PDF, chooses extraction strategy, saves .md files + guide.yaml                |
| `src/chunker.ts`                 | pdf-parse text extraction + heading-based segmentation + stable content-hash IDs    |
| `src/llm-client.ts`              | All LLM calls — circuit breaker, error classification, exponential backoff + jitter |
| `src/scripts/validate.ts`        | Zod structural check; per-file read guard                                           |
| `src/scripts/relate.ts`          | LLM-based related_chunks linking; per-file read guard; retry via callLlmWithRetry   |
| `src/scripts/rebuild-guide.ts`   | Reads all .md front-matter → writes guide.yaml; per-file read guard                 |
| `src/scripts/source-manifest.ts` | PDF hash + chunk provenance tracking                                                |
