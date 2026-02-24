import { readFile, writeFile, mkdir, readdir, stat } from "fs/promises";
import { join, resolve, extname, basename } from "path";
import { extractChunksFromDocument } from "./llm-client.js";
import type { GuideEntry, LLMChunkOutput } from "./schemas.js";
import {
  loadManifest,
  saveManifest,
  hashBuffer,
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

// ─── Markdown chunk assembler ──────────────────────────────────────────────────
// Converts a validated LLMChunkOutput into the canonical .md format defined
// in the architecture spec. Front matter is YAML, body has fixed sections.

function assembleChunkMarkdown(chunk: LLMChunkOutput): string {
  const lines: string[] = [];

  // ── YAML front matter ────────────────────────────────────────────────────────
  lines.push("---");
  lines.push(`chunk_id: ${chunk.chunk_id}`);
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

  // ── Conditions — only when has_conditions: true ──────────────────────────────
  if (chunk.has_conditions && chunk.conditions) {
    lines.push("## Conditions");
    lines.push("");
    lines.push(chunk.conditions.trim());
    lines.push("");
  }

  // ── Constraints — only when hard limits exist ────────────────────────────────
  if (chunk.constraints) {
    lines.push("## Constraints");
    lines.push("");
    lines.push(chunk.constraints.trim());
    lines.push("");
  }

  // ── Response — always present for active chunks ──────────────────────────────
  lines.push("## Response");
  lines.push("");
  lines.push(chunk.response.trim());
  lines.push("");

  // ── Escalation — always present ──────────────────────────────────────────────
  lines.push("## Escalation");
  lines.push("");
  lines.push(chunk.escalation_detail.trim());
  lines.push("");

  // ── Image descriptions — appended if present ─────────────────────────────────
  // These are not customer-facing but are stored in the chunk for future use
  // (e.g. generating alt text, grounding answers with visual context).
  if (chunk.image_descriptions && chunk.image_descriptions.length > 0) {
    lines.push("## Images");
    lines.push("");
    for (const img of chunk.image_descriptions) {
      lines.push(`### ${img.caption || "Unnamed image"}`);
      lines.push("");
      lines.push(`**Position:** ${img.position_hint}`);
      lines.push("");
      lines.push(`**Description:** ${img.full_description}`);
      lines.push("");
      lines.push(`**Relevance:** ${img.relevance}`);
      lines.push("");
    }
  }

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
        const topic = block.match(/\n\s+topic:\s*(.+)/)?.[1]?.trim() ?? "";
        const summary =
          block.match(/summary:\s*>\s*\n\s+(.+)/)?.[1]?.trim() ?? "";
        const file = block.match(/\n\s+file:\s*(.+)/)?.[1]?.trim() ?? "";
        const has_conditions =
          block.match(/\n\s+has_conditions:\s*(true|false)/)?.[1] === "true";
        const escalationRaw =
          block.match(/\n\s+escalation:\s*(.+)/)?.[1]?.trim() ?? "null";
        const escalation =
          escalationRaw === "null" ? null : escalationRaw.replace(/^"|"$/g, "");
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
            topic,
            summary,
            triggers,
            has_conditions,
            escalation,
            related_chunks,
            status,
            file,
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
    lines.push(`    topic: ${entry.topic}`);
    lines.push(`    summary: >`);
    lines.push(`      ${entry.summary}`);

    lines.push(`    triggers:`);
    for (const trigger of entry.triggers) {
      lines.push(`      - "${trigger.replace(/"/g, "'")}"`);
    }

    lines.push(`    has_conditions: ${entry.has_conditions}`);

    if (entry.escalation) {
      lines.push(`    escalation: "${entry.escalation.replace(/"/g, "'")}"`);
    } else {
      lines.push(`    escalation: null`);
    }

    lines.push(`    related_chunks:`);
    for (const rel of entry.related_chunks) {
      lines.push(`      - ${rel}`);
    }

    lines.push(`    status: ${entry.status}`);
    lines.push(`    file: ${entry.file}`);
    lines.push("");
  }

  await writeFile(GUIDE_PATH, lines.join("\n"), "utf-8");
  console.log(`\n📘 guide.yaml updated — ${entries.length} chunk(s)\n`);
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
    console.warn(`
⚠️  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️  CONTEXT WINDOW SIZE WARNING (GAP-D1-19)
⚠️
⚠️  Knowledge base now has ${currentCount} chunks (${fileKb.toFixed(1)} KB).
⚠️  Retrieval sends the full guide.yaml to the LLM on every query.
⚠️  At this scale, you risk exceeding the LLM context window.
⚠️
⚠️  Recommended: migrate to embedding-based retrieval (vector store).
⚠️  See: https://sdk.vercel.ai/docs/ai-sdk-core/embeddings
⚠️  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
  }
}

async function readPdf(
  filePath: string,
): Promise<{ base64: string; buf: Buffer }> {
  console.log(`📄 Reading PDF: ${filePath}`);
  const buf = await readFile(filePath);
  return { base64: buf.toString("base64"), buf };
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
  extractionType: "procedure" | "qna" = "procedure",
): Promise<LLMChunkOutput[]> {
  const label = `⏱  LLM extraction (single-shot) [${basename(source)}]`;
  console.time(label);
  const chunks = await extractChunksFromDocument(
    base64,
    undefined,
    extractionType,
  );
  console.timeEnd(label);
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
  extractionType: "procedure" | "qna" = "procedure",
): Promise<LLMChunkOutput[]> {
  const { deriveChunkId } = await import("./chunker.js");
  const allChunks: LLMChunkOutput[] = [];

  console.log(
    `\n📋 Extracting ${segments.length} segment(s) individually (${extractionType} mode)...\n`,
  );

  for (const seg of segments) {
    const label = `⏱  segment [${seg.stableChunkId}]`;
    console.time(label);

    let segmentPrompt: string;

    if (extractionType === "qna") {
      segmentPrompt =
        `You are extracting Q&A pairs/FAQs from a specific section of a PDF.\n\n` +
        `SECTION HEADING: ${seg.headingPath.join(" › ")}\n` +
        `SECTION PAGES: ${seg.pageRange.start}–${seg.pageRange.end}\n\n` +
        `SECTION TEXT:\n${seg.content}\n\n---\n\n` +
        `Extract ONLY valid Questions and Answers found in this section.\n` +
        `Required fields for each Q&A chunk: chunk_id, topic, summary, triggers (the question), ` +
        `has_conditions, escalation, related_chunks, status, context, response (the answer), image_descriptions.\n` +
        `Return ONLY a raw JSON array. Start with [ and end with ]. No markdown fences.`;
    } else {
      segmentPrompt =
        `You are extracting from a specific section of a PDF document.\n\n` +
        `SECTION HEADING: ${seg.headingPath.join(" › ")}\n` +
        `SECTION PAGES: ${seg.pageRange.start}–${seg.pageRange.end}\n\n` +
        `SECTION TEXT:\n${seg.content}\n\n---\n\n` +
        `Extract the knowledge in this section only. Produce a SINGLE chunk JSON object (not an array).\n` +
        `Required fields: chunk_id, topic, summary, triggers, has_conditions, escalation, ` +
        `related_chunks, status, context, response, escalation_detail, image_descriptions.\n` +
        `Return ONLY valid JSON. No markdown fences. No explanation.`;
    }

    try {
      const chunks = await extractChunksFromDocument(
        base64,
        segmentPrompt,
        extractionType,
      );
      console.timeEnd(label);

      for (const chunk of chunks) {
        // Override LLM-generated ID with our deterministic content-hash ID
        // Note: For QnA, if multiple Q&A's in one segment, we append a suffix
        const baseStableId = deriveChunkId(seg.headingPath, chunk.topic);
        const stableId =
          chunks.length > 1
            ? `${baseStableId}-${chunks.indexOf(chunk)}`
            : baseStableId;

        console.log(`  ✓ ${stableId}  (LLM suggested: ${chunk.chunk_id})`);
        allChunks.push({ ...chunk, chunk_id: stableId });
      }
    } catch (err) {
      console.timeEnd(label);
      console.warn(
        `  ⚠️  Segment "${seg.stableChunkId}" extraction failed:`,
        err,
      );
    }
  }

  return allChunks;
}

// ─── Core extraction pipeline ──────────────────────────────────────────────────

async function extractSingle(
  source: string,
  outputDir: string,
  manifest: Awaited<ReturnType<typeof loadManifest>>,
  extractionType: "procedure" | "qna" = "procedure",
): Promise<{
  saved: number;
  newCount: number;
  updatedCount: number;
  chunkIds: string[];
}> {
  const { base64: content, buf } = await readPdf(source);
  const currentHash = hashBuffer(buf);

  console.log(`  ↳ PDF size: ${(buf.length / 1024).toFixed(1)} KB\n`);

  // ── Step 1: Extract plain text for deterministic segmentation (GAP-D1-01) ────
  let chunks: LLMChunkOutput[];

  const pdfText = await decodePdfToText(content);

  if (pdfText.length > CONFIG.extraction.minTextLengthForSegmentation) {
    // Text layer available — use deterministic segment-per-LLM-call pipeline
    const docTitle = basename(source).replace(/\.pdf$/i, "");
    const segments = segmentDocument(pdfText, docTitle);
    logSegmentSummary(segments);

    if (segments.length === 0) {
      console.log(
        "  ⚠️  Segmenter produced 0 segments. Falling back to single-shot extraction.\n",
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
    console.log(
      "  ⚠️  No text layer found (image-only PDF?). Using single-shot LLM extraction.\n",
    );
    chunks = await fallbackExtract(content, source, extractionType);
  }

  if (chunks.length === 0) {
    console.log("  ⚠️  No chunks extracted from this document.\n");
    return { saved: 0, newCount: 0, updatedCount: 0, chunkIds: [] };
  }

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

      const markdown = assembleChunkMarkdown(chunk);
      await writeFile(filePath, markdown, "utf-8");

      const existingIdx = guide.findIndex((e) => e.chunk_id === chunk.chunk_id);
      const entry: GuideEntry = {
        chunk_id: chunk.chunk_id,
        topic: chunk.topic,
        summary: chunk.summary,
        triggers: chunk.triggers,
        has_conditions: chunk.has_conditions,
        escalation: chunk.escalation,
        related_chunks: chunk.related_chunks,
        status: chunk.status,
        file: relPath,
      };

      if (existingIdx >= 0) {
        guide[existingIdx] = entry;
        console.log(`  ↻ Updated: ${fileName}`);
        updatedCount++;
      } else {
        guide.push(entry);
        console.log(`  ✓ Created: ${fileName}`);
        newCount++;
      }

      console.log(`    Topic:      ${chunk.topic}`);
      console.log(`    Summary:    ${chunk.summary}`);
      console.log(`    Triggers:   ${chunk.triggers.length}`);
      console.log(`    Images:     ${chunk.image_descriptions.length}`);
      console.log(`    Conditions: ${chunk.has_conditions}`);
      console.log("");

      savedCount++;
      savedChunkIds.push(chunk.chunk_id);
    } catch (error) {
      console.error(`  ✗ Failed to save chunk "${chunk.chunk_id}":`, error);
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
        console.warn(`⚠️  No PDF files found in directory: ${resolved}`);
      } else {
        console.log(`📂 Found ${pdfs.length} PDF(s) in ${resolved}\n`);
        sources.push(...pdfs);
      }
    } else if (info.isFile()) {
      if (extname(resolved).toLowerCase() !== ".pdf") {
        console.warn(`⚠️  Skipping non-PDF file: ${arg}`);
      } else {
        sources.push(resolved);
      }
    } else {
      console.warn(`⚠️  Skipping unknown path: ${arg}`);
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

  const typeFlag = args.find((a) => a.startsWith("--type="));
  const extractionType: "procedure" | "qna" =
    typeFlag === "--type=qna" ? "qna" : "procedure";
  const sourcesArgs = args.filter((a) => !a.startsWith("--type="));

  try {
    const sources = await resolveSources(sourcesArgs);

    if (sources.length === 0) {
      console.error("❌ No valid PDF sources found.");
      process.exit(1);
    }

    console.log(
      `\n🚀 Starting extraction for ${sources.length} source(s)...\n`,
    );

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
      console.log(`\n━━━ [${i + 1}/${sources.length}] ${label} ━━━\n`);

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
        console.error(`❌ Failed to extract from ${label}:`, err);
        totalFailed++;
      }
    }

    // ── Save updated manifest (GAP-D1-17) ─────────────────────────────────────
    await saveManifest(manifest);
    console.log(`\n📋 source-manifest.json updated`);

    // ── Extraction summary report (GAP-D1-18) ─────────────────────────────────
    const totalElapsed = ((Date.now() - extractStart) / 1000).toFixed(1);
    const totalSaved = totalNew + totalUpdated;

    console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 Extraction Summary
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Sources processed : ${sources.length}
   Chunks created    : ${totalNew}
   Chunks updated    : ${totalUpdated}
   Sources failed    : ${totalFailed}
   Total time        : ${totalElapsed}s
   Output directory  : ${outputDir}
   Guide index       : data/guide.yaml
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Next steps:
  1. Validate chunks:  bun run validate
  2. Link related:     bun run relate
  3. Rebuild index:    bun run rebuild
  — or run all steps: bun run ingest <sources>
`);
  } catch (error) {
    console.error("Extraction failed:", error);
    process.exit(1);
  }
}

main();
