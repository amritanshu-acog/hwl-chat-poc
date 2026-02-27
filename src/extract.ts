import { readFile, writeFile, mkdir, readdir, stat, unlink } from "fs/promises";
import { join, resolve, extname, basename } from "path";
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
  deriveChunkId,
  type DocumentSegment,
} from "./chunker.js";
import { renderPrompt } from "./prompt-loader.js";
import { parseGuideEntries, serializeGuideEntries } from "./guide-parser.js";
import { CONFIG } from "./config.js";
import { logger, childLogger } from "./logger.js";

// ─── Markdown chunk assembler ──────────────────────────────────────────────────

function assembleChunkMarkdown(
  chunk: LLMChunkOutput,
  source: string,
  extractionType: "procedure" | "qna" | "chat",
): string {
  const lines: string[] = [];

  lines.push("---");
  lines.push(`chunk_id: ${chunk.chunk_id}`);
  lines.push(`source: ${source}`);
  lines.push(`topic: ${chunk.topic}`);
  lines.push(`summary: >`);
  lines.push(`  ${chunk.summary}`);
  lines.push("triggers:");
  for (const trigger of chunk.triggers) {
    lines.push(`  - "${trigger.replace(/"/g, "'")}"`);
  }
  lines.push(`has_conditions: ${chunk.has_conditions}`);
  lines.push("related_chunks:");
  for (const rel of chunk.related_chunks) {
    lines.push(`  - ${rel}`);
  }
  lines.push(`status: ${chunk.status}`);
  lines.push("---");
  lines.push("");
  lines.push("## Context");
  lines.push("");
  lines.push(chunk.context.trim());
  lines.push("");
  lines.push("## Response");
  lines.push("");
  if (chunk.has_conditions && chunk.conditions) {
    lines.push("### Conditions");
    lines.push("");
    lines.push(chunk.conditions.trim());
    lines.push("");
  }
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

// ─── Guide helpers ────────────────────────────────────────────────────────────

const GUIDE_PATH = CONFIG.paths.guide;

async function loadGuide(): Promise<GuideEntry[]> {
  try {
    return parseGuideEntries(await readFile(GUIDE_PATH, "utf-8"));
  } catch {
    return [];
  }
}

async function saveGuide(entries: GuideEntry[]): Promise<void> {
  await writeFile(GUIDE_PATH, serializeGuideEntries(entries), "utf-8");
  logger.info("guide.yaml updated", { totalChunks: entries.length });
}

// ─── Context-window size guard (GAP-D1-19) ────────────────────────────────────

async function checkContextWindowSize(currentCount: number): Promise<void> {
  if (currentCount <= 80) return;
  let fileKb = 0;
  try {
    fileKb = (await stat(GUIDE_PATH)).size / 1024;
  } catch {
    /* ignore */
  }
  if (currentCount > 80 || fileKb > 50) {
    logger.warn(
      "GAP-D1-19: Context window size warning — consider embedding-based retrieval",
      {
        chunkCount: currentCount,
        guideSizeKB: fileKb.toFixed(1),
        recommendation: "Migrate to embedding-based retrieval (vector store)",
      },
    );
  }
}

// ─── PDF reader ───────────────────────────────────────────────────────────────

async function readPdf(
  filePath: string,
): Promise<{ base64: string; buf: Buffer }> {
  try {
    const buf = await readFile(filePath);
    return { base64: buf.toString("base64"), buf };
  } catch (err) {
    logger.error("Could not read PDF file", {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

// ─── Extraction strategies ────────────────────────────────────────────────────

async function fallbackExtract(
  base64: string,
  source: string,
  extractionType: "procedure" | "qna" | "chat" = "procedure",
): Promise<LLMChunkOutput[]> {
  const log = childLogger({ source: basename(source), extractionType });
  const t0 = Date.now();
  const chunks = await extractChunksFromDocument(
    base64,
    undefined,
    extractionType,
  );
  log.info("LLM extraction complete", {
    durationMs: Date.now() - t0,
    chunksProduced: chunks.length,
  });
  return chunks;
}

async function extractFromSegments(
  segments: DocumentSegment[],
  base64: string,
  source: string,
  extractionType: "procedure" | "qna" | "chat" = "procedure",
): Promise<LLMChunkOutput[]> {
  const allChunks: LLMChunkOutput[] = [];
  logger.info("Segment-level extraction started", {
    totalSegments: segments.length,
    extractionType,
  });

  for (const seg of segments) {
    const t0 = Date.now();
    const promptName =
      extractionType === "qna" ? "segment-qna" : "segment-procedure";
    const segmentPrompt = await renderPrompt(promptName, {
      HEADING: seg.headingPath.join(" › "),
      PAGES: `${seg.pageRange.start}–${seg.pageRange.end}`,
      CONTENT: seg.content,
    });

    try {
      const chunks = await extractChunksFromDocument(
        extractionType === "qna" ? "" : base64,
        segmentPrompt,
        extractionType,
      );
      logger.debug("Segment LLM call complete", {
        segmentId: seg.stableChunkId,
        durationMs: Date.now() - t0,
        chunksProduced: chunks.length,
      });
      allChunks.push(...chunks);
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

  // Skip if unchanged and chunks already exist
  const previousChunkIds = getChunkIdsForSource(manifest, source);
  if (
    isUnchanged(manifest, source, currentHash) &&
    previousChunkIds.length > 0
  ) {
    log.info("PDF unchanged — skipping extraction", {
      existingChunks: previousChunkIds.length,
    });
    return {
      saved: 0,
      newCount: 0,
      updatedCount: 0,
      chunkIds: previousChunkIds,
    };
  }

  // Clean up stale chunks from previous run
  if (previousChunkIds.length > 0) {
    log.info("PDF changed — removing stale chunks", {
      staleChunks: previousChunkIds.length,
    });
    const guide = await loadGuide();
    await saveGuide(
      guide.filter((e) => !previousChunkIds.includes(e.chunk_id)),
    );
    for (const chunkId of previousChunkIds) {
      try {
        await unlink(join(outputDir, `${chunkId}.md`));
      } catch {
        /* already gone */
      }
    }
  }

  // Choose extraction strategy
  let chunks: LLMChunkOutput[];
  const isSmallPdf = buf.length < 2 * 1024 * 1024;

  if (isSmallPdf) {
    chunks = await fallbackExtract(content, source, extractionType);
  } else {
    const pdfText = await decodePdfToText(content);
    if (pdfText.length > CONFIG.extraction.minTextLengthForSegmentation) {
      const docTitle = basename(source).replace(/\.pdf$/i, "");
      const segments = segmentDocument(pdfText, docTitle);
      logSegmentSummary(segments);

      const tempPath = CONFIG.paths.temp[extractionType];
      await mkdir(tempPath, { recursive: true });
      for (const seg of segments) {
        await writeFile(
          join(tempPath, `${seg.stableChunkId}.txt`),
          seg.content,
          "utf-8",
        );
      }

      chunks =
        segments.length === 0
          ? await fallbackExtract(content, source, extractionType)
          : await extractFromSegments(
              segments,
              content,
              source,
              extractionType,
            );
    } else {
      log.warn("No text layer found — using single-shot LLM extraction", {
        textLength: pdfText.length,
      });
      chunks = await fallbackExtract(content, source, extractionType);
    }
  }

  if (chunks.length === 0) {
    log.warn("No chunks extracted from source");
    return { saved: 0, newCount: 0, updatedCount: 0, chunkIds: [] };
  }

  // Assign stable chunk IDs
  chunks = chunks.map((chunk) => ({
    ...chunk,
    chunk_id: deriveChunkId(source, chunk.topic, chunk.chunk_id),
  }));

  // Save chunks and update guide
  const guide = await loadGuide();
  let savedCount = 0,
    newCount = 0,
    updatedCount = 0;
  const savedChunkIds: string[] = [];

  for (const chunk of chunks) {
    try {
      const fileName = `${chunk.chunk_id}.md`;
      const filePath = join(outputDir, fileName);
      await writeFile(
        filePath,
        assembleChunkMarkdown(chunk, basename(source), extractionType),
        "utf-8",
      );

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

      const existingIdx = guide.findIndex((e) => e.chunk_id === chunk.chunk_id);
      if (existingIdx >= 0) {
        guide[existingIdx] = entry;
        updatedCount++;
      } else {
        guide.push(entry);
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

  log.info("Chunks saved", {
    new: newCount,
    updated: updatedCount,
    chunkIds: savedChunkIds,
  });

  await saveGuide(guide);
  await checkContextWindowSize(guide.length);
  recordExtraction(manifest, source, currentHash, buf.length, savedChunkIds);

  return { saved: savedCount, newCount, updatedCount, chunkIds: savedChunkIds };
}

// ─── Input resolution ─────────────────────────────────────────────────────────

async function resolveSources(args: string[]): Promise<string[]> {
  const sources: string[] = [];
  for (const arg of args) {
    const resolved = resolve(arg);
    const info = await stat(resolved);
    if (info.isDirectory()) {
      const pdfs = (await readdir(resolved))
        .filter((f) => extname(f).toLowerCase() === ".pdf")
        .sort()
        .map((f) => join(resolved, f));
      if (pdfs.length === 0)
        logger.warn("No PDFs found in directory", { directory: resolved });
      else sources.push(...pdfs);
    } else if (info.isFile()) {
      if (extname(resolved).toLowerCase() !== ".pdf")
        logger.warn("Skipping non-PDF", { path: arg });
      else sources.push(resolved);
    } else {
      logger.warn("Skipping unknown path", { path: arg });
    }
  }
  return sources;
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

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
  A single PDF file, multiple PDFs, or a directory (all PDFs).

Tip: For a full ingestion pipeline use: bun run ingest <sources>
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
      logger.error("No valid PDF sources found");
      process.exit(1);
    }

    logger.info("Extraction pipeline started", {
      totalSources: sources.length,
    });

    const outputDir = CONFIG.paths.chunks;
    await mkdir(outputDir, { recursive: true });
    await mkdir(CONFIG.paths.data, { recursive: true });

    const manifest = await loadManifest();
    let totalNew = 0,
      totalUpdated = 0,
      totalFailed = 0;
    const extractStart = Date.now();

    for (let i = 0; i < sources.length; i++) {
      const source = sources[i]!;
      logger.info(`Processing source [${i + 1}/${sources.length}]`, {
        source: basename(source),
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
        logger.error("Extraction failed", {
          source: basename(source),
          error: err instanceof Error ? err.message : String(err),
        });
        totalFailed++;
      }
    }

    await saveManifest(manifest);
    logger.info("Extraction pipeline complete", {
      sourcesProcessed: sources.length,
      chunksCreated: totalNew,
      chunksUpdated: totalUpdated,
      sourcesFailed: totalFailed,
      elapsedSeconds: ((Date.now() - extractStart) / 1000).toFixed(1),
    });
  } catch (error) {
    logger.error("Extraction pipeline failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

main();
