import { readFile, writeFile, mkdir, readdir, stat, unlink } from "fs/promises";
import { join, resolve, extname, basename } from "path";
import { createHash } from "crypto";
import { extractChunksFromDocument } from "./llm-client.js";
import type { GuideEntry, LLMChunkOutput } from "./schemas.js";
import {
  loadManifest,
  saveManifest,
  hashBuffer,
  isUnchanged,
  recordExtraction,
  getChunkIdsForSource,
} from "./scripts/source-manifest.js";
import {
  decodePdfToText,
  segmentDocument,
  logSegmentSummary,
  type DocumentSegment,
} from "./chunker.js";
import { CONFIG } from "./config.js";
import { logger } from "./logger.js";
import { childLogger } from "./logger.js";

// ─── Markdown chunk assembler ──────────────────────────────────────────────────
// Converts a validated LLMChunkOutput into the canonical .md format defined
// in the architecture spec. Front matter is YAML, body has fixed sections.

function assembleChunkMarkdown(
  chunk: LLMChunkOutput,
  source: string,
  extractionType: "procedure" | "qna" | "chat",
): string {
  const lines: string[] = [];

  // ── YAML front matter ────────────────────────────────────────────────────────
  lines.push("---");
  lines.push(`chunk_id: ${chunk.chunk_id}`);
  lines.push(`source: ${source}`);
  lines.push(`topic: ${chunk.topic}`);

  // Multi-line summary uses YAML block scalar
  lines.push(`summary: >`);
  lines.push(`  ${chunk.summary}`);

  lines.push("triggers:");
  for (const trigger of chunk.triggers) {
    lines.push(`  - "${trigger.replace(/"/g, "'")}"`);
  }

  lines.push(`has_conditions: ${chunk.has_conditions}`);

  if (chunk.escalation) {
    lines.push(`escalation: "${chunk.escalation.replace(/"/g, "'")}"`);
  } else {
    lines.push("escalation: null");
  }

  lines.push("related_chunks:");
  for (const rel of chunk.related_chunks) {
    lines.push(`  - ${rel}`);
  }

  lines.push(`status: ${chunk.status}`);
  lines.push("---");
  lines.push("");

  // ── Context — always present ─────────────────────────────────────────────────
  lines.push("## Context");
  lines.push("");
  lines.push(chunk.context.trim());
  lines.push("");

  // ── Response — always present for active chunks ──────────────────────────────
  lines.push("## Response");
  lines.push("");

  // ── Conditions — only when has_conditions: true ──────────────────────────────
  if (chunk.has_conditions && chunk.conditions) {
    lines.push("### Conditions");
    lines.push("");
    lines.push(chunk.conditions.trim());
    lines.push("");
  }

  // ── Constraints — only when hard limits exist ────────────────────────────────
  if (chunk.constraints) {
    lines.push("#### Constraints");
    lines.push("");
    lines.push(chunk.constraints.trim());
    lines.push("");
  }

  lines.push(chunk.response.trim());
  lines.push("");

  return lines.join("\n");
}

// ─── Guide YAML helpers ────────────────────────────────────────────────────────

const GUIDE_PATH = CONFIG.paths.guide;

async function loadGuide(): Promise<GuideEntry[]> {
  try {
    const raw = await readFile(GUIDE_PATH, "utf-8");
    const entries: GuideEntry[] = [];

    // Parse YAML blocks split by chunk_id markers
    const blocks = raw
      .split(/^  - chunk_id:/m)
      .filter((b) => b.trim() && !b.trim().startsWith("#"));

    for (const block of blocks) {
      try {
        const chunk_id = block.match(/^\s*([^\n]+)/)?.[1]?.trim() ?? "";
        const source =
          block.match(/\n\s+source:\s*(.+)/)?.[1]?.trim() ?? "unknown";
        const topic = block.match(/\n\s+topic:\s*(.+)/)?.[1]?.trim() ?? "";
        const summary =
          block.match(/summary:\s*>\s*\n\s+(.+)/)?.[1]?.trim() ?? "";
        const has_conditions =
          block.match(/\n\s+has_conditions:\s*(true|false)/)?.[1] === "true";
        const status = (block.match(/\n\s+status:\s*(\w+)/)?.[1]?.trim() ??
          "active") as "active" | "review" | "deprecated";

        // Parse triggers — collect lines between "triggers:" and next key
        const triggersSection = block.match(
          /\n\s+triggers:\s*\n((?:\s+- .+\n?)*)/,
        );
        const triggers = triggersSection?.[1]
          ? [...triggersSection[1].matchAll(/- "?(.+?)"?\s*$/gm)].map((m) =>
              m[1]!.trim(),
            )
          : [];

        // Parse related_chunks — same approach
        const relatedSection = block.match(
          /\n\s+related_chunks:\s*\n((?:\s+- .+\n?)*)/,
        );
        const related_chunks = relatedSection?.[1]
          ? [...relatedSection[1].matchAll(/- (.+?)\s*$/gm)].map((m) =>
              // Normalize: strip 'chunk_id:' prefixes (GAP-D1-05)
              m[1]!.trim().replace(/^chunk_id:/i, ""),
            )
          : [];

        if (chunk_id && topic) {
          entries.push({
            chunk_id,
            source,
            topic,
            summary,
            triggers,
            has_conditions,
            related_chunks,
            status,
          });
        }
      } catch {
        // skip malformed block
      }
    }

    return entries;
  } catch {
    return [];
  }
}

/**
 * Serialize all guide entries to guide.yaml.
 * The format mirrors the spec exactly — extracted from chunk front matter.
 */
async function saveGuide(entries: GuideEntry[]): Promise<void> {
  const lines: string[] = [
    "# Knowledge Base Guide Index",
    "# Auto-generated from chunk front matter — do not edit manually",
    "# Source of truth: individual chunk .md files in data/chunks/",
    "",
    "chunks:",
    "",
  ];

  for (const entry of entries) {
    lines.push(`  - chunk_id: ${entry.chunk_id}`);
    lines.push(`    source: ${entry.source}`);
    lines.push(`    topic: ${entry.topic}`);
    lines.push(`    summary: >`);
    lines.push(`      ${entry.summary}`);

    lines.push(`    triggers:`);
    for (const trigger of entry.triggers) {
      lines.push(`      - "${trigger.replace(/"/g, "'")}"`);
    }

    lines.push(`    has_conditions: ${entry.has_conditions}`);

    lines.push(`    related_chunks:`);
    for (const rel of entry.related_chunks) {
      lines.push(`      - ${rel}`);
    }

    lines.push(`    status: ${entry.status}`);
    lines.push("");
  }

  await writeFile(GUIDE_PATH, lines.join("\n"), "utf-8");
  logger.info("guide.yaml updated", { totalChunks: entries.length });
}

// ─── Guide context-window size guard (GAP-D1-19) ─────────────────────────────

const MAX_CHUNKS_BEFORE_WARNING = 80;
const MAX_GUIDE_KB_BEFORE_WARNING = 50;

async function checkContextWindowSize(
  guidePath: string,
  currentCount: number,
): Promise<void> {
  if (currentCount <= MAX_CHUNKS_BEFORE_WARNING) return;

  let fileKb = 0;
  try {
    const info = await stat(guidePath);
    fileKb = info.size / 1024;
  } catch {
    /* ignore */
  }

  if (
    currentCount > MAX_CHUNKS_BEFORE_WARNING ||
    fileKb > MAX_GUIDE_KB_BEFORE_WARNING
  ) {
    logger.warn(
      "GAP-D1-19: Context window size warning — consider embedding-based retrieval",
      {
        chunkCount: currentCount,
        guideSizeKB: fileKb.toFixed(1),
        recommendation: "Migrate to embedding-based retrieval (vector store)",
        ref: "https://sdk.vercel.ai/docs/ai-sdk-core/embeddings",
      },
    );
  }
}

async function readPdf(
  filePath: string,
): Promise<{ base64: string; buf: Buffer }> {
  logger.info("Reading PDF", { filePath });
  try {
    const buf = await readFile(filePath);
    return { base64: buf.toString("base64"), buf };
  } catch (err) {
    logger.error("Could not read PDF file", {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err; // re-throw so extractSingle() caller sees a clear log first
  }
}

// ─── Extraction strategies ────────────────────────────────────────────────────

/**
 * Fallback: original single-shot LLM extraction.
 * Used when pdf-parse can't extract text (image-only PDFs).
 * Non-deterministic — the LLM decides boundaries and IDs itself.
 */
async function fallbackExtract(
  base64: string,
  source: string,
  extractionType: "procedure" | "qna" | "chat" = "procedure",
): Promise<LLMChunkOutput[]> {
  const log = childLogger({ source: basename(source), extractionType });
  log.info("LLM extraction (single-shot) started");
  const t0 = Date.now();
  const chunks = await extractChunksFromDocument(
    base64,
    undefined,
    extractionType,
  );
  log.info("LLM extraction (single-shot) complete", {
    durationMs: Date.now() - t0,
    chunksProduced: chunks.length,
  });
  return chunks;
}

/**
 * Deterministic segment-level extraction (GAP-D1-01).
 *
 * For each pre-bounded segment from segmentDocument():
 *   1. Build a per-segment prompt containing the section text.
 *   2. Call LLM with segment prompt + full PDF (for image context).
 *   3. OVERRIDE the LLM's chunk_id with our stable deriveChunkId() ID.
 *
 * Result: same PDF → same segments → same IDs every time.
 * LLM non-determinism only affects wording, not boundaries or IDs.
 */
async function extractFromSegments(
  segments: DocumentSegment[],
  base64: string,
  source: string,
  extractionType: "procedure" | "qna" | "chat" = "procedure",
): Promise<LLMChunkOutput[]> {
  const { deriveChunkId } = await import("./chunker.js");
  const allChunks: LLMChunkOutput[] = [];

  logger.info("Segment-level extraction started", {
    totalSegments: segments.length,
    extractionType,
  });

  for (const seg of segments) {
    const t0 = Date.now();

    let segmentPrompt: string;

    if (extractionType === "qna") {
      segmentPrompt =
        `You are extracting Q&A pairs/FAQs from a specific section of a PDF.\n\n` +
        `SECTION HEADING: ${seg.headingPath.join(" › ")}\n` +
        `SECTION PAGES: ${seg.pageRange.start}–${seg.pageRange.end}\n\n` +
        `SECTION TEXT:\n${seg.content}\n\n---\n\n` +
        `Extract ONLY valid Questions and Answers found in this section.\n` +
        `Required fields for each Q&A chunk: chunk_id, topic, summary, triggers (the question), ` +
        `has_conditions, escalation, related_chunks, status, context, response (the answer).\n` +
        `Return ONLY a raw JSON array. Start with [ and end with ]. No markdown fences.`;
    } else {
      segmentPrompt =
        `You are extracting from a specific section of a PDF document.\n\n` +
        `SECTION HEADING: ${seg.headingPath.join(" › ")}\n` +
        `SECTION PAGES: ${seg.pageRange.start}–${seg.pageRange.end}\n\n` +
        `SECTION TEXT:\n${seg.content}\n\n---\n\n` +
        `Extract the knowledge in this section only. Produce a SINGLE chunk JSON object (not an array).\n` +
        `Required fields: chunk_id, topic, summary, triggers, has_conditions, escalation, ` +
        `related_chunks, status, context, response, escalation_detail.\n` +
        `Return ONLY valid JSON. No markdown fences. No explanation.`;
    }

    try {
      const chunks = await extractChunksFromDocument(
        extractionType === "qna" ? "" : base64,
        segmentPrompt,
        extractionType,
      );
      logger.info("Segment LLM call complete", {
        segmentId: seg.stableChunkId,
        durationMs: Date.now() - t0,
        chunksProduced: chunks.length,
      });

      for (const chunk of chunks) {
        // Override LLM-generated ID with our deterministic content-hash ID
        // Note: For QnA, if multiple Q&A's in one segment, we append a suffix
        const baseStableId = deriveChunkId(seg.headingPath, chunk.topic);
        const stableId =
          chunks.length > 1
            ? `${baseStableId}-${chunks.indexOf(chunk)}`
            : baseStableId;

        logger.debug("Chunk ID derived", {
          stableId,
          llmSuggestedId: chunk.chunk_id,
        });
        allChunks.push({ ...chunk, chunk_id: stableId });
      }
    } catch (err) {
      logger.warn("Segment extraction failed", {
        segmentId: seg.stableChunkId,
        durationMs: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return allChunks;
}

// ─── Stable chunk ID helpers ──────────────────────────────────────────────────

/**
 * Convert arbitrary text to a lowercase-hyphen slug.
 * Used to sanitise LLM-suggested chunk_id / topic into a safe slug prefix.
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 50)
    .replace(/^-|-$/g, "");
}

/**
 * Derive a stable, human-readable chunk ID in the form `{slug}-{shortHash}`.
 *
 * The 8-char hex suffix is sha256(sourceBasename + topic) — deterministic,
 * so the same document + topic always produces the same ID regardless of
 * what name the LLM happened to suggest this run.
 *
 * @param source      Absolute path to the source PDF
 * @param topic       The chunk topic returned by the LLM
 * @param llmSlug     Optional: the LLM-suggested chunk_id to use as slug prefix
 */
function deriveStableChunkId(
  source: string,
  topic: string,
  llmSlug?: string,
): string {
  const shortHash = createHash("sha256")
    .update(basename(source) + topic)
    .digest("hex")
    .slice(0, 8);

  const slug = llmSlug ? slugify(llmSlug) : slugify(topic);

  return `${slug}-${shortHash}`;
}

// ─── Core extraction pipeline ──────────────────────────────────────────────────

async function extractSingle(
  source: string,
  outputDir: string,
  manifest: Awaited<ReturnType<typeof loadManifest>>,
  extractionType: "procedure" | "qna" | "chat" = "procedure",
): Promise<{
  saved: number;
  newCount: number;
  updatedCount: number;
  chunkIds: string[];
}> {
  const log = childLogger({ source: basename(source), extractionType });
  const { base64: content, buf } = await readPdf(source);
  const currentHash = hashBuffer(buf);
  log.info("PDF loaded", { sizeKB: (buf.length / 1024).toFixed(1) });

  // ── Hash-skip guard: skip entirely if PDF is unchanged and previously succeeded ─
  const previousChunkIds = getChunkIdsForSource(manifest, source);
  if (
    isUnchanged(manifest, source, currentHash) &&
    previousChunkIds.length > 0
  ) {
    log.info("PDF unchanged — skipping extraction (hash match)", {
      hash: currentHash.substring(0, 16),
      existingChunks: previousChunkIds.length,
    });
    return {
      saved: 0,
      newCount: 0,
      updatedCount: 0,
      chunkIds: previousChunkIds,
    };
  }

  // ── Stale-chunk cleanup: remove all chunks from previous extraction of this PDF ─
  // This runs when the PDF has changed (or the first run produced 0 chunks).
  // It guarantees no orphaned entries survive in guide.yaml or data/chunks/.
  if (previousChunkIds.length > 0) {
    log.info("PDF changed — removing stale chunks from previous extraction", {
      staleChunks: previousChunkIds.length,
    });
    const staleGuide = await loadGuide();
    const cleanedGuide = staleGuide.filter(
      (e) => !previousChunkIds.includes(e.chunk_id),
    );
    await saveGuide(cleanedGuide);

    for (const chunkId of previousChunkIds) {
      const stalePath = join(outputDir, `${chunkId}.md`);
      try {
        await unlink(stalePath);
        log.info("Deleted stale chunk file", { chunkId });
      } catch {
        // File may not exist if the previous extraction partially failed — ignore
      }
    }
  }

  // ── Step 1: Extract plain text for deterministic segmentation (GAP-D1-01) ────
  let chunks: LLMChunkOutput[];

  const isSmallPdf = buf.length < 4 * 1024 * 1024;

  if (isSmallPdf) {
    log.info("PDF < 4 MB — bypassing chunker, sending directly to LLM");
    chunks = await fallbackExtract(content, source, extractionType);
  } else {
    const pdfText = await decodePdfToText(content);

    if (pdfText.length > CONFIG.extraction.minTextLengthForSegmentation) {
      // Text layer available — use deterministic segment-per-LLM-call pipeline
      const docTitle = basename(source).replace(/\.pdf$/i, "");
      const segments = segmentDocument(pdfText, docTitle);
      logSegmentSummary(segments);

      // Save deterministic chunks to temp directories as per Milan's feedback
      const tempPath = CONFIG.paths.temp[extractionType];
      await mkdir(tempPath, { recursive: true });
      for (const seg of segments) {
        await writeFile(
          join(tempPath, `${seg.stableChunkId}.txt`),
          seg.content,
          "utf-8",
        );
      }
      logger.info(
        `Dumped ${segments.length} deterministic chunks to ${tempPath}`,
      );

      if (segments.length === 0) {
        logger.warn(
          "Segmenter produced 0 segments. Falling back to single-shot extraction.",
        );
        chunks = await fallbackExtract(content, source, extractionType);
      } else {
        chunks = await extractFromSegments(
          segments,
          content,
          source,
          extractionType,
        );
      }
    } else {
      // Image-only PDF: no text layer — fall back to single-shot LLM extraction
      log.warn(
        "No text layer found in PDF — using single-shot LLM extraction",
        {
          textLength: pdfText.length,
          reason: "image-only PDF or text extraction failure",
        },
      );
      chunks = await fallbackExtract(content, source, extractionType);
    }
  }

  if (chunks.length === 0) {
    log.warn("No chunks extracted from document", { source: basename(source) });
    return { saved: 0, newCount: 0, updatedCount: 0, chunkIds: [] };
  }

  // ── Override LLM chunk IDs with deterministic slug-hash IDs ──────────────────
  // The LLM picks chunk_id names non-deterministically — "add-candidate-staff-pool"
  // on one run, "add-candidate-to-staff-pool" on the next. This makes deduplication
  // by ID impossible. We replace the LLM ID with slug-shortHash where the 8-char
  // hash is sha256(sourceBasename + topic), making the ID stable for the same PDF
  // and topic even if the LLM's wording drifts between runs.
  chunks = chunks.map((chunk) => ({
    ...chunk,
    chunk_id: deriveStableChunkId(source, chunk.topic, chunk.chunk_id),
  }));
  log.info("Stable chunk IDs assigned", {
    chunks: chunks.map((c) => c.chunk_id),
  });

  // ── Step 2: Save chunks and update guide ──────────────────────────────────────
  const guide = await loadGuide();
  let savedCount = 0;
  let newCount = 0;
  let updatedCount = 0;
  const savedChunkIds: string[] = [];

  for (const chunk of chunks) {
    try {
      const fileName = `${chunk.chunk_id}.md`;
      const filePath = join(outputDir, fileName);
      const relPath = `data/chunks/${fileName}`;

      const markdown = assembleChunkMarkdown(
        chunk,
        basename(source),
        extractionType,
      );
      await writeFile(filePath, markdown, "utf-8");

      const existingIdx = guide.findIndex((e) => e.chunk_id === chunk.chunk_id);
      const entry: GuideEntry = {
        chunk_id: chunk.chunk_id,
        source: basename(source),
        topic: chunk.topic,
        summary: chunk.summary,
        triggers: chunk.triggers,
        has_conditions: chunk.has_conditions,
        related_chunks: chunk.related_chunks,
        status: chunk.status,
      };

      if (existingIdx >= 0) {
        guide[existingIdx] = entry;
        log.info("Chunk updated", { chunkId: chunk.chunk_id, fileName });
        updatedCount++;
      } else {
        guide.push(entry);
        log.info("Chunk created", {
          chunkId: chunk.chunk_id,
          fileName,
          topic: chunk.topic,
          triggers: chunk.triggers.length,
          hasConditions: chunk.has_conditions,
        });
        newCount++;
      }

      savedCount++;
      savedChunkIds.push(chunk.chunk_id);
    } catch (error) {
      log.error("Failed to save chunk", {
        chunkId: chunk.chunk_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await saveGuide(guide);

  // Context window size guard (GAP-D1-19)
  await checkContextWindowSize(GUIDE_PATH, guide.length);

  // Update source manifest (GAP-D1-14 / GAP-D1-17)
  recordExtraction(manifest, source, currentHash, buf.length, savedChunkIds);

  return { saved: savedCount, newCount, updatedCount, chunkIds: savedChunkIds };
}

// ─── Input resolution ──────────────────────────────────────────────────────────

async function resolveSources(args: string[]): Promise<string[]> {
  const sources: string[] = [];

  for (const arg of args) {
    const resolved = resolve(arg);
    const info = await stat(resolved);

    if (info.isDirectory()) {
      const entries = await readdir(resolved);
      const pdfs = entries
        .filter((f) => extname(f).toLowerCase() === ".pdf")
        .sort()
        .map((f) => join(resolved, f));

      if (pdfs.length === 0) {
        logger.warn("No PDF files found in directory", { directory: resolved });
      } else {
        logger.info("PDFs resolved from directory", {
          directory: resolved,
          count: pdfs.length,
        });
        sources.push(...pdfs);
      }
    } else if (info.isFile()) {
      if (extname(resolved).toLowerCase() !== ".pdf") {
        logger.warn("Skipping non-PDF file", { path: arg });
      } else {
        sources.push(resolved);
      }
    } else {
      logger.warn("Skipping unknown path", { path: arg });
    }
  }

  return sources;
}

// ─── CLI Entry Point ─────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(`
Usage:
  bun run extract [options] <source> [source2] ...

Options:
  --type=procedure  Extract standard procedures (default)
  --type=qna        Extract Q&A pairs / FAQs

Sources:
  • A single PDF file      bun run extract ./manual.pdf
  • Multiple PDFs          bun run extract a.pdf b.pdf
  • A directory (all PDFs) bun run extract ./docs/
  • Mixed                  bun run extract --type=qna faq.pdf

Tip: For a full ingestion pipeline (extract → validate → relate → rebuild),
     use: bun run ingest <sources>
`);
    process.exit(1);
  }

  const typeFlag = args
    .find((a) => a.startsWith("--type="))
    ?.replace("--type=", "");
  const extractionType: "procedure" | "qna" | "chat" =
    typeFlag === "qna" ? "qna" : typeFlag === "chat" ? "chat" : "procedure";
  const sourcesArgs = args.filter((a) => !a.startsWith("--type="));

  try {
    const sources = await resolveSources(sourcesArgs);

    if (sources.length === 0) {
      logger.error("No valid PDF sources found — aborting");
      process.exit(1);
    }

    logger.info("Extraction pipeline started", {
      totalSources: sources.length,
    });

    const outputDir = CONFIG.paths.chunks;
    await mkdir(outputDir, { recursive: true });
    await mkdir(CONFIG.paths.data, { recursive: true });

    // ── Load source manifest (GAP-D1-14 / GAP-D1-17) ──────────────────────────
    const manifest = await loadManifest();

    // ── Per-source extraction with summary tracking (GAP-D1-18) ──────────────
    let totalNew = 0;
    let totalUpdated = 0;
    let totalFailed = 0;
    const extractStart = Date.now();

    for (let i = 0; i < sources.length; i++) {
      const source = sources[i]!;
      const label = basename(source);
      logger.info(`Processing source [${i + 1}/${sources.length}]`, {
        source: label,
      });

      try {
        const result = await extractSingle(
          source,
          outputDir,
          manifest,
          extractionType,
        );
        totalNew += result.newCount;
        totalUpdated += result.updatedCount;
      } catch (err) {
        logger.error("Extraction failed for source", {
          source: label,
          error: err instanceof Error ? err.message : String(err),
        });
        totalFailed++;
      }
    }

    // ── Save updated manifest (GAP-D1-17) ─────────────────────────────────────
    await saveManifest(manifest);
    logger.info("source-manifest.json updated");

    // ── Extraction summary report (GAP-D1-18) ─────────────────────────────────
    const totalElapsed = ((Date.now() - extractStart) / 1000).toFixed(1);
    const totalSaved = totalNew + totalUpdated;

    logger.info("Extraction pipeline complete", {
      sourcesProcessed: sources.length,
      chunksCreated: totalNew,
      chunksUpdated: totalUpdated,
      sourcesFailed: totalFailed,
      totalSaved,
      elapsedSeconds: totalElapsed,
      outputDir,
    });
  } catch (error) {
    logger.error("Extraction pipeline failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

main();
