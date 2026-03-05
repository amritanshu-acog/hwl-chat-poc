# HWL Troubleshooting Assistant — Backend

An AI-powered helpdesk API that answers questions strictly from your own PDF documentation.

---

## Prerequisites

- [Bun](https://bun.sh) v1.0+
- Azure OpenAI account with the following deployed:
  - `gpt-4o` — for chunk extraction and chat
  - `gpt-4o-mini` — for trigger normalisation
  - `text-embedding-3-large` — for related chunk computation

---

## Installation

```bash
git clone <repo-url>
cd troubleshooting-poc
bun install
cp .env.example .env
```

Fill in `.env`:

```env
AZURE_API_KEY=your-key
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
AZURE_OPENAI_DEPLOYMENT_NAME=gpt-4o
AZURE_API_VERSION=2024-12-01-preview
CORS_ORIGIN=http://localhost:5173
```

---

## Step 1 — Generate Validation Rules (First Time Only)

Before processing any PDFs, generate the validation rules:

```bash
bun run gen:generate-rules
```

This reads the chunking prompts and asks the LLM to produce rules used to validate chunk quality. Output goes to `generation/rules/`. Only needs to be run once unless you change the prompts.

---

## Step 2 — Add PDFs

Drop your PDF documents into the appropriate input folder:

```
generation/input/procedure/    ← how-to guides, user manuals, step-by-step docs
generation/input/qna/          ← FAQ documents, Q&A style content
```

---

## Step 3 — Run the Pipeline

```bash
bun run gen:run:procedure      # Process procedure PDFs
bun run gen:run:qna            # Process QnA PDFs
bun run gen:run                # Process both
```

The pipeline runs 4 stages automatically:

| Stage       | What it does                                                                                                    |
| ----------- | --------------------------------------------------------------------------------------------------------------- |
| **Chunk**   | Sends each PDF to the LLM, extracts structured knowledge chunks as `.md` files                                  |
| **Quality** | Validates every chunk against rules. Passes go to `pass/`, failures go to `fail/` with a report                 |
| **Compile** | Promotes passing chunks to `output/final/`, rebuilds `guide.yaml` index, computes related chunks via embeddings |
| **Archive** | Moves processed PDFs to `input/processed/` so they aren't reprocessed                                           |

Output lands in `generation/output/final/` — this is what the chat server reads.

---

## Step 4 — Start the Server

```bash
bun run server
```

Server starts on `http://localhost:3000`.

```
POST /api/chat     — ask a question
GET  /api/health   — server status
GET  /api/chunks   — list all indexed chunks
```

---

## Adding New PDFs Later

1. Drop new PDFs into `generation/input/procedure/` or `generation/input/qna/`
2. Run `bun run gen:run:procedure` or `bun run gen:run:qna`
3. Restart the server

---

## Removing a PDF from the Knowledge Base

```bash
bun run gen:delete "HWL Agency_Staff Pool V3.pdf"
```

This removes all chunks from that PDF, backs up the current state, and rebuilds the index.

---

## Manual Stage Commands

Use these if the pipeline fails partway and you need to re-run a specific stage:

```bash
bun run gen:quality:procedure  # Re-run quality validation only
bun run gen:compile            # Re-run compile only
bun run gen:reembed            # Recompute related chunks (e.g. after model change)
```

---

## Project Structure

```
generation/
  input/
    procedure/         ← drop procedure PDFs here
    qna/               ← drop QnA PDFs here
    processed/         ← PDFs move here after successful processing
  output/
    chunk/             ← raw LLM output per run
    quality/           ← pass/ and fail/ dirs with reports
    final/             ← production chunks + guide.yaml (server reads this)
  pipeline/            ← pipeline stage source code
  prompts/             ← LLM prompt templates
  rules/               ← generated validation rules
  config.toml          ← all pipeline configuration

server/
  api/server.ts        ← HTTP server entry point
  cli/chat.ts          ← terminal chat for testing
  llm/client.ts        ← retrieval + generation logic
```

---

## Configuration

All pipeline settings are in `generation/config.toml`:

| Setting                    | Default                  | Description                                    |
| -------------------------- | ------------------------ | ---------------------------------------------- |
| `single_pass_threshold_kb` | `2048`                   | PDFs above this size use two-pass extraction   |
| `section_delay_seconds`    | `60`                     | Delay between section calls in two-pass mode   |
| `related_chunks.threshold` | `0.75`                   | Cosine similarity threshold for related chunks |
| `related_chunks.model`     | `text-embedding-3-large` | Embedding model                                |

---

## Troubleshooting

**Pipeline fails at quality stage**
Check `generation/output/quality/fail/procedure/` — each failed chunk has the exact rule violation logged.

**Embeddings failing**
Verify `text-embedding-3-large` is deployed in your Azure instance. Update `related_chunks.model` in `config.toml` if using a different model, then run `bun run gen:reembed`.

**Server shows 0 chunks**
The pipeline hasn't run yet or `generation/output/final/guide.yaml` doesn't exist. Run the pipeline first.

**PDFs not being picked up**
Check they aren't already in `generation/input/processed/` — processed PDFs are archived there and won't be reprocessed.
