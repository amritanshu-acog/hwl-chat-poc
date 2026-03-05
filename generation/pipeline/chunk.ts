/**
 * generation/pipeline/chunk.ts
 *
 * Chunk stage — §4 of the design spec.
 *
 * For each input PDF:
 *   - Small PDF (≤ threshold): single pass — base64 inline → LLM → .md files
 *   - Large PDF (> threshold): two pass — TOC extracted first, then one LLM
 *     call per section, each with the full PDF base64 inline.
 *
 * TOC extraction uses a 3-tier fallback (§4.4):
 *   Tier 1 — PDF bookmarks (deterministic, no LLM)
 *   Tier 2 — Dot-leader pattern scan (deterministic, no LLM)
 *   Tier 3 — LLM via base64 inline call (fallback)
 *
 * Output: <uuid>.md files in output/chunk/<doc_type>/
 * The output directory is wiped at the start of every run.
 */

import { readdir, readFile, writeFile, rm, mkdir, stat } from "fs/promises";
import { join, basename } from "path";
import { CONFIG } from "../core/config.js";
import { makeLogger } from "../core/logger.js";
import { callLlm, loadPromptFile } from "../core/llm.js";
import { withBackoff } from "../utils/backoff.js";
import {
  parseXmlResponse,
  injectChunkMetadata,
  assembleChunkMarkdown,
} from "../utils/xml-parser.js";
import type { StageLogger } from "../core/logger.js";

// pdfjs-dist — used for Tier 1 (bookmarks) and Tier 2 (dot-leader scan).
// Requires: bun add pdfjs-dist
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ChunkResult {
  doc_type: "procedure" | "qna";
  processed: string[];
  skipped: string[];
  chunks_written: number;
}

interface TocResult {
  headings: string[];
  tier: 1 | 2 | 3;
  inputTokens: number;
  outputTokens: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fileSizeKb(filePath: string): Promise<number> {
  const s = await stat(filePath);
  return s.size / 1024;
}

async function toBase64(filePath: string): Promise<string> {
  const buf = await readFile(filePath);
  return buf.toString("base64");
}

async function writeChunkFile(
  chunk: ReturnType<typeof injectChunkMetadata>,
  outDir: string,
): Promise<string> {
  const md = assembleChunkMarkdown(chunk);
  const filename = `${chunk.chunk_id}.md`;
  await writeFile(join(outDir, filename), md, "utf-8");
  return filename;
}

// ─── Tier 1 — PDF Bookmark extraction ────────────────────────────────────────
//
// §4.4 Tier 1: Read the PDF's built-in bookmark/outline tree.
// Extract level-1 (top-level) entries only.
// Returns null if no bookmarks exist or extraction fails — caller falls through.

async function extractTocFromBookmarks(
  pdfPath: string,
  skipHeadings: string[],
  log: StageLogger,
): Promise<string[] | null> {
  try {
    const data = new Uint8Array(await readFile(pdfPath));
    const pdf = await pdfjsLib.getDocument({ data, verbosity: 0 }).promise;
    const outline = await pdf.getOutline();

    if (!outline || outline.length === 0) {
      log.info("TOC Tier 1: no bookmarks found in PDF");
      return null;
    }

    // Extract only top-level (level-1) bookmark titles.
    const headings: string[] = [];
    for (const item of outline) {
      const title = item.title?.trim();
      if (title && !skipHeadings.includes(title)) {
        headings.push(title);
      }
    }

    if (headings.length === 0) {
      log.info("TOC Tier 1: bookmarks found but all were empty or skipped");
      return null;
    }

    log.info("TOC Tier 1: bookmarks extracted successfully", {
      count: headings.length,
    });
    return headings;
  } catch (err) {
    log.warn("TOC Tier 1: bookmark extraction failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ─── Tier 2 — Dot-leader pattern scan ────────────────────────────────────────
//
// §4.4 Tier 2: Scan first toc_max_pages pages for lines matching the pattern:
//   "text ........ page_number"  (3+ dots followed by a number at end of line)
//
// Hierarchy is determined by x-position:
//   minimum x-position across all matches = top-level.
//
// Returns null if no dot-leader lines found — caller falls through to Tier 3.

async function extractTocFromDotLeaders(
  pdfPath: string,
  skipHeadings: string[],
  log: StageLogger,
): Promise<string[] | null> {
  try {
    const data = new Uint8Array(await readFile(pdfPath));
    const pdf = await pdfjsLib.getDocument({ data, verbosity: 0 }).promise;
    const maxPages = Math.min(CONFIG.chunks.toc_max_pages, pdf.numPages);

    // Dot-leader pattern: text followed by 3+ dots/periods and a page number.
    const dotLeaderPattern = /^(.+?)\s*\.{3,}\s*(\d+)\s*$/;

    // Collect all matching lines with their x-positions.
    interface TocLine {
      text: string;
      x: number;
    }
    const tocLines: TocLine[] = [];

    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();

      // pdfjs returns text as individual items with transform [scaleX, skewX, skewY, scaleY, x, y].
      // We reconstruct lines by grouping items with similar y-positions.
      interface TextItem {
        str: string;
        x: number;
        y: number;
      }
      const items: TextItem[] = [];

      for (const item of textContent.items) {
        if ("str" in item && item.str.trim()) {
          const transform = (item as any).transform as number[];
          items.push({
            str: item.str,
            x: transform[4] ?? 0,
            y: transform[5] ?? 0,
          });
        }
      }

      // Group by y-position (round to nearest 2px to handle sub-pixel differences).
      const lineMap = new Map<number, TextItem[]>();
      for (const item of items) {
        const yKey = Math.round(item.y / 2) * 2;
        const existing = lineMap.get(yKey) ?? [];
        existing.push(item);
        lineMap.set(yKey, existing);
      }

      // Sort lines top-to-bottom (descending y in PDF coordinate space).
      const sortedLines = [...lineMap.entries()].sort((a, b) => b[0] - a[0]);

      for (const [, lineItems] of sortedLines) {
        // Sort items left-to-right within the line.
        lineItems.sort((a, b) => a.x - b.x);
        const lineText = lineItems
          .map((i) => i.str)
          .join(" ")
          .trim();
        const match = dotLeaderPattern.exec(lineText);

        if (match) {
          const heading = match[1]?.trim() ?? "";
          // x-position of the first item in this line = indentation level.
          const x = lineItems[0]?.x ?? 0;
          if (heading && !skipHeadings.includes(heading)) {
            tocLines.push({ text: heading, x });
          }
        }
      }
    }

    if (tocLines.length === 0) {
      log.info("TOC Tier 2: no dot-leader lines found");
      return null;
    }

    // §4.4: minimum x-position across all matches = top-level hierarchy.
    const minX = Math.min(...tocLines.map((l) => l.x));
    // Allow a small tolerance for slight indentation variance (5px).
    const topLevelTolerance = 5;
    const topLevelHeadings = tocLines
      .filter((l) => l.x <= minX + topLevelTolerance)
      .map((l) => l.text);

    if (topLevelHeadings.length === 0) {
      log.info("TOC Tier 2: no top-level headings after x-position filter");
      return null;
    }

    log.info("TOC Tier 2: dot-leader scan successful", {
      totalLines: tocLines.length,
      topLevel: topLevelHeadings.length,
      minX: Math.round(minX),
    });

    return topLevelHeadings;
  } catch (err) {
    log.warn("TOC Tier 2: dot-leader scan failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ─── Tier 3 — LLM extraction via base64 inline ───────────────────────────────
//
// §4.4 Tier 3: Send the PDF inline as base64 to the LLM using heading.md prompt.
// Only reached when Tier 1 and Tier 2 both fail to find headings.

async function extractTocViaLlm(
  pdfBase64: string,
  headingPrompt: string,
  skipHeadings: string[],
  log: StageLogger,
): Promise<{ headings: string[]; inputTokens: number; outputTokens: number }> {
  log.info("TOC Tier 3: falling back to LLM extraction");

  const result = await withBackoff(
    () =>
      callLlm(
        {
          system: headingPrompt,
          prompt: "Extract all top-level section headings from this document.",
          pdfBase64,
        },
        log,
      ),
    log,
  );

  const responseText = result.text;
  const headings: string[] = [];
  const sectionMatches = [
    ...responseText.matchAll(/<section>([\s\S]*?)<\/section>/g),
  ];

  for (const match of sectionMatches) {
    const block = match[1] ?? "";
    const headingMatch = block.match(/<heading>([\s\S]*?)<\/heading>/);
    if (headingMatch) {
      const h = headingMatch[1]?.trim();
      if (h) headings.push(h);
    }
  }

  // §4.4 Tier 3: if exactly one top-level heading returned, promote
  // subsections to top-level — provided there are at least 2 subsections.
  if (headings.length === 1) {
    const subsections: string[] = [];
    for (const match of sectionMatches) {
      const block = match[1] ?? "";
      const subMatches = [
        ...block.matchAll(/<subsections>([\s\S]*?)<\/subsections>/g),
      ];
      for (const sub of subMatches) {
        const subHeadings = [
          ...(sub[1] ?? "").matchAll(/<heading>([\s\S]*?)<\/heading>/g),
        ];
        for (const sh of subHeadings) {
          const h = sh[1]?.trim();
          if (h) subsections.push(h);
        }
      }
    }
    if (subsections.length >= 2) {
      log.info("TOC Tier 3: single top-level heading — promoting subsections", {
        count: subsections.length,
      });
      return {
        headings: subsections.filter((h) => !skipHeadings.includes(h)),
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      };
    }
  }

  return {
    headings: headings.filter((h) => !skipHeadings.includes(h)),
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  };
}

// ─── TOC orchestrator — 3-tier fallback ──────────────────────────────────────
//
// §4.4: Try Tier 1 → Tier 2 → Tier 3 in sequence.
// If Tier 1 or 2 succeeds, Tier 3 is not called.
// pdfBase64 is only encoded and passed if Tier 3 is reached.

async function extractToc(
  pdfPath: string,
  pdfBase64: string,
  headingPrompt: string,
  skipHeadings: string[],
  log: StageLogger,
): Promise<TocResult> {
  // ── Tier 1: PDF bookmarks ─────────────────────────────────────────────────
  const tier1 = await extractTocFromBookmarks(pdfPath, skipHeadings, log);
  if (tier1 !== null) {
    log.info("TOC: Tier 1 succeeded", { headings: tier1.length });
    return { headings: tier1, tier: 1, inputTokens: 0, outputTokens: 0 };
  }

  // ── Tier 2: Dot-leader pattern scan ──────────────────────────────────────
  const tier2 = await extractTocFromDotLeaders(pdfPath, skipHeadings, log);
  if (tier2 !== null) {
    log.info("TOC: Tier 2 succeeded", { headings: tier2.length });
    return { headings: tier2, tier: 2, inputTokens: 0, outputTokens: 0 };
  }

  // ── Tier 3: LLM extraction ────────────────────────────────────────────────
  log.info("TOC: Tiers 1 and 2 both failed — using Tier 3 (LLM)");
  const tier3 = await extractTocViaLlm(
    pdfBase64,
    headingPrompt,
    skipHeadings,
    log,
  );
  return {
    headings: tier3.headings,
    tier: 3,
    inputTokens: tier3.inputTokens,
    outputTokens: tier3.outputTokens,
  };
}

// ─── Single-pass extraction ───────────────────────────────────────────────────

async function singlePass(
  pdfPath: string,
  systemPrompt: string,
  outDir: string,
  log: StageLogger,
): Promise<number> {
  const source = basename(pdfPath);
  log.info("Single pass: encoding PDF", { source });

  const pdfBase64 = await toBase64(pdfPath);

  const result = await withBackoff(
    () =>
      callLlm(
        {
          system: systemPrompt,
          prompt:
            "Read every page of this PDF carefully. Extract ALL distinct procedures/sections. " +
            "Return chunks in the XML format specified.",
          pdfBase64,
        },
        log,
      ),
    log,
  );

  const rawChunks = parseXmlResponse(result.text);
  log.info("Single pass: parsed chunks", { source, count: rawChunks.length });

  let written = 0;
  for (const raw of rawChunks) {
    const chunk = injectChunkMetadata(raw, source);
    await writeChunkFile(chunk, outDir);
    written++;
  }

  log.info("Single pass: complete", { source, written });
  return written;
}

// ─── Two-pass extraction ──────────────────────────────────────────────────────

async function twoPass(
  pdfPath: string,
  systemPrompt: string,
  headingPrompt: string,
  outDir: string,
  log: StageLogger,
): Promise<number> {
  const source = basename(pdfPath);
  log.info("Two pass: starting", { source });

  // Encode once — reused for TOC Tier 3 (if needed) and all section calls.
  const pdfBase64 = await toBase64(pdfPath);

  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // ── TOC extraction — 3-tier fallback ──────────────────────────────────────
  const skipHeadings = (CONFIG.chunks as any).skip_headings ?? [];
  const toc = await extractToc(
    pdfPath,
    pdfBase64,
    headingPrompt,
    skipHeadings,
    log,
  );

  totalInputTokens += toc.inputTokens;
  totalOutputTokens += toc.outputTokens;

  log.info("Two pass: TOC extraction complete", {
    source,
    tier: toc.tier,
    headings: toc.headings.length,
  });

  const headings = toc.headings;

  // ── Fallback: no headings → full document call ────────────────────────────
  if (headings.length === 0) {
    log.warn(
      "Two pass: no headings found in any tier — falling back to full document call",
      { source },
    );

    const result = await withBackoff(
      () =>
        callLlm(
          {
            system: systemPrompt,
            prompt:
              "Read every page of this PDF. Extract ALL sections as chunks in the XML format specified.",
            pdfBase64,
          },
          log,
        ),
      log,
    );

    totalInputTokens += result.inputTokens;
    totalOutputTokens += result.outputTokens;

    const rawChunks = parseXmlResponse(result.text);
    let written = 0;
    for (const raw of rawChunks) {
      const chunk = injectChunkMetadata(raw, source);
      await writeChunkFile(chunk, outDir);
      written++;
    }

    log.info("Two pass: token summary", {
      source,
      totalInputTokens,
      totalOutputTokens,
      totalTokens: totalInputTokens + totalOutputTokens,
    });
    log.info("Two pass fallback: complete", { source, written });
    return written;
  }

  log.info("Two pass: headings found", { source, count: headings.length });

  // ── Per-section loop ───────────────────────────────────────────────────────
  const delayMs = CONFIG.chunks.section_delay_seconds * 1000;
  let totalWritten = 0;

  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i]!;
    const nextHeading = headings[i + 1];
    const isLast = i === headings.length - 1;

    const sectionPrompt = isLast
      ? `Extract and format the section '${heading}' to the end of the document`
      : `Extract and format the section '${heading}' ending before '${nextHeading}'`;

    log.info("Two pass: processing section", {
      source,
      section: i + 1,
      of: headings.length,
      heading,
    });

    const result = await withBackoff(
      () =>
        callLlm(
          {
            system: systemPrompt,
            prompt: sectionPrompt,
            pdfBase64,
          },
          log,
        ),
      log,
    );

    totalInputTokens += result.inputTokens;
    totalOutputTokens += result.outputTokens;

    const rawChunks = parseXmlResponse(result.text);
    for (const raw of rawChunks) {
      const chunk = injectChunkMetadata(raw, source);
      await writeChunkFile(chunk, outDir);
      totalWritten++;
    }

    log.info("Two pass: section complete", {
      source,
      heading,
      chunksFromSection: rawChunks.length,
    });

    if (!isLast) {
      log.info(
        `Two pass: waiting ${CONFIG.chunks.section_delay_seconds}s before next section`,
      );
      await new Promise<void>((r) => setTimeout(r, delayMs));
    }
  }

  log.info("Two pass: token summary", {
    source,
    totalInputTokens,
    totalOutputTokens,
    totalTokens: totalInputTokens + totalOutputTokens,
  });
  log.info("Two pass: complete", { source, totalWritten });
  return totalWritten;
}

// ─── Stage ────────────────────────────────────────────────────────────────────

export async function runChunk(
  doc_type: "procedure" | "qna",
): Promise<ChunkResult> {
  const log = makeLogger("chunk");

  const inputDir =
    doc_type === "procedure"
      ? CONFIG.directories.input_procedure
      : CONFIG.directories.input_qna;

  const outDir = join(CONFIG.directories.output_chunk, doc_type);
  const thresholdKb = CONFIG.chunks.single_pass_threshold_kb;

  log.info("Chunk stage started", { doc_type, inputDir, outDir });

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  log.info("Output directory wiped and recreated", { outDir });

  const systemPromptPath =
    doc_type === "procedure" ? CONFIG.prompts.procedure : CONFIG.prompts.qna;

  const systemPrompt = loadPromptFile(systemPromptPath);
  const headingPrompt = loadPromptFile(CONFIG.prompts.heading);

  let allFiles: string[];
  try {
    allFiles = await readdir(inputDir);
  } catch {
    log.warn("Input directory not readable — no PDFs to process", { inputDir });
    return { doc_type, processed: [], skipped: [], chunks_written: 0 };
  }

  const pdfs = allFiles.filter((f) => f.toLowerCase().endsWith(".pdf")).sort();

  if (pdfs.length === 0) {
    log.info("No PDFs found in input directory", { doc_type, inputDir });
    return { doc_type, processed: [], skipped: [], chunks_written: 0 };
  }

  log.info("PDFs to process", { doc_type, count: pdfs.length });

  const processed: string[] = [];
  const skipped: string[] = [];
  let chunks_written = 0;

  for (const filename of pdfs) {
    const pdfPath = join(inputDir, filename);
    log.info("Processing PDF", { filename });

    try {
      const sizeKb = await fileSizeKb(pdfPath);
      log.info("PDF size", { filename, sizeKb: Math.round(sizeKb) });

      let written: number;

      if (sizeKb <= thresholdKb) {
        written = await singlePass(pdfPath, systemPrompt, outDir, log);
      } else {
        log.info("PDF exceeds threshold — using two-pass", {
          filename,
          sizeKb: Math.round(sizeKb),
          thresholdKb,
        });
        written = await twoPass(
          pdfPath,
          systemPrompt,
          headingPrompt,
          outDir,
          log,
        );
      }

      chunks_written += written;
      processed.push(filename);
    } catch (err) {
      log.error("PDF processing failed — skipping", {
        filename,
        error: err instanceof Error ? err.message : String(err),
      });
      skipped.push(filename);
    }
  }

  log.info("Chunk stage complete", {
    doc_type,
    processed: processed.length,
    skipped: skipped.length,
    chunks_written,
  });

  return { doc_type, processed, skipped, chunks_written };
}
