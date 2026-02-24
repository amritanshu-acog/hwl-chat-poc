# What Happens When You Run `bun run ingest my.pdf`

---

## Step-by-step, plain English

### 1. `ingest.ts` starts

Resolves your PDF path to an absolute path. Then runs 4 steps in order by calling each script as a child process.

---

### 2. `extract.ts` — reads the PDF and calls the LLM

```
extract.ts → readPdf()
           → decodePdfToText()     [chunker.ts]  — pdf-parse extracts plain text
           → segmentDocument()     [chunker.ts]  — splits text into sections by ALL-CAPS headings
           → extractFromSegments() [extract.ts]  — calls LLM once per segment
               └─ for each segment:
                     extractChunksFromDocument()  [llm-client.ts]  ← 1 LLM call
                     deriveChunkId()              [chunker.ts]      ← stable ID override
           → assembleChunkMarkdown() → writeFile(data/chunks/<id>.md)
           → saveGuide()             → writes data/guide.yaml
           → recordExtraction()      → writes source-manifest.json
```

**LLM calls in this step:** 1 per segment  
**If pdf-parse fails** (image-only PDF): 1 single LLM call for the whole PDF (fallback)

---

### 3. `validate.ts` — quality check on every chunk

```
validate.ts → reads all active .md files
            → Phase 1: Zod schema check (no LLM, instant)
            → Phase 2: 1 LLM call per chunk — checks Clarity + Completeness
            → failed chunks → status: review (removed from retrieval)
            → rebuild-guide.ts (regenerates guide.yaml with updated statuses)
```

**LLM calls in this step:** 1 per active chunk

---

### 4. `relate.ts` — links related chunks

```
relate.ts → 1 LLM call per active chunk — asks "which other chunks are related?"
          → writes related_chunks into each .md front-matter
          → rebuild-guide.ts (regenerates guide.yaml)
```

**LLM calls in this step:** 1 per active chunk

---

### 5. `rebuild-guide.ts` — regenerates guide.yaml

```
rebuild-guide.ts → reads every .md front-matter → writes data/guide.yaml
```

**LLM calls in this step:** 0

---

## Total LLM calls for 1 PDF

| Step                       | Calls      |
| -------------------------- | ---------- |
| Extract (N segments)       | N          |
| Validate (M active chunks) | M          |
| Relate (M active chunks)   | M          |
| **Total**                  | **N + 2M** |

---

## Output files after ingestion

```
data/
├── guide.yaml              ← index of all active chunks (chunk_id, topic, triggers, file path)
├── chunks/
│   ├── add-candidate-to-staff-pool-<hash>.md
│   ├── upload-proposal-documents-<hash>.md
│   └── ...
source-manifest.json        ← which PDF produced which chunk_ids (for deduplication)
```

---

## Files involved

| File                             | What it does                                                        |
| -------------------------------- | ------------------------------------------------------------------- |
| `src/scripts/ingest.ts`          | Orchestrator — runs all 4 scripts in sequence                       |
| `src/extract.ts`                 | Reads PDF, runs segmentation, saves .md files                       |
| `src/chunker.ts`                 | pdf-parse text extraction + heading-based segmentation + stable IDs |
| `src/llm-client.ts`              | All LLM calls (extraction, validation quality check, relate)        |
| `src/scripts/validate.ts`        | Zod check + LLM quality gates on each chunk                         |
| `src/scripts/relate.ts`          | LLM-based related_chunks linking                                    |
| `src/scripts/rebuild-guide.ts`   | Reads all .md front-matter → writes guide.yaml                      |
| `src/scripts/source-manifest.ts` | PDF hash + chunk provenance tracking                                |
