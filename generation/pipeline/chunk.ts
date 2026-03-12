/**
 * generation/pipeline/chunk.ts
 *
 * Chunk stage — §4 of the design spec.
 *
 * For each input file, the processing path is chosen per §4.1 decision tree:
 *
 *   Large file (> threshold):
 *     - PDF in two_pass_formats  → two-pass (TOC + section loop)
 *     - Otherwise                → skip with warning
 *
 *   Small file (≤ threshold):
 *     - PDF                      → single-pass base64 inline
 *     - DOCX                     → extract text, re-check size, single-pass as text
 *     - MD / TXT / other single_pass_formats → read directly, single-pass as text
 *
 * TOC extraction uses a 3-tier fallback (§4.4):
 *   Tier 1 — PDF bookmarks (deterministic, no LLM)
 *   Tier 2 — Dot-leader pattern scan (deterministic, no LLM)
 *   Tier 3 — LLM via base64 inline call (fallback)
 *
 * Two-pass mode controlled by CONFIG.chunks.use_files_api:
 *   false (default) — base64 inline on every call
 *   true            — upload to Files API, reference by file_id, delete in finally
 *
 * Output: <uuid>.md files in output/chunk/<doc_type>/
 * The output directory is wiped at the start of every run.
 */

import { readdir, readFile, writeFile, rm, mkdir, stat } from "fs/promises";
import { join, basename, extname } from "path";
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
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

// mammoth — DOCX text extraction
import mammoth from "mammoth";

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

function getExt(filename: string): string {
  return extname(filename).toLowerCase().replace(".", "");
}

// ─── PDF validation ───────────────────────────────────────────────────────────

async function validatePdf(
  pdfPath: string,
  log: StageLogger,
): Promise<{ valid: boolean; reason?: string }> {
  try {
    const sizeKb = await fileSizeKb(pdfPath);
    if (sizeKb < 1) {
      return {
        valid: false,
        reason: `File too small (${Math.round(sizeKb * 1024)} bytes)`,
      };
    }

    const buf = await readFile(pdfPath);
    const header = buf.slice(0, 5).toString("ascii");
    if (header !== "%PDF-") {
      return {
        valid: false,
        reason: `Not a valid PDF — header is "${header}"`,
      };
    }

    const data = new Uint8Array(buf);
    const pdf = await pdfjsLib.getDocument({ data, verbosity: 0 }).promise;
    if (pdf.numPages === 0) {
      return { valid: false, reason: "PDF has zero pages" };
    }

    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Tier 1 — PDF Bookmark extraction ────────────────────────────────────────

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

async function extractTocFromDotLeaders(
  pdfPath: string,
  skipHeadings: string[],
  log: StageLogger,
): Promise<string[] | null> {
  try {
    const data = new Uint8Array(await readFile(pdfPath));
    const pdf = await pdfjsLib.getDocument({ data, verbosity: 0 }).promise;
    const maxPages = Math.min(CONFIG.chunks.toc_max_pages, pdf.numPages);

    const dotLeaderPattern = /^(.+?)\s*\.{3,}\s*(\d+)\s*$/;

    interface TocLine {
      text: string;
      x: number;
      pageNum: number;
    }
    const tocLines: TocLine[] = [];

    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();

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

      const lineMap = new Map<number, TextItem[]>();
      for (const item of items) {
        const yKey = Math.round(item.y / 2) * 2;
        const existing = lineMap.get(yKey) ?? [];
        existing.push(item);
        lineMap.set(yKey, existing);
      }

      const sortedLines = [...lineMap.entries()].sort((a, b) => b[0] - a[0]);

      for (const [, lineItems] of sortedLines) {
        lineItems.sort((a, b) => a.x - b.x);
        const lineText = lineItems
          .map((i) => i.str)
          .join(" ")
          .trim();
        const match = dotLeaderPattern.exec(lineText);

        if (match) {
          const heading = match[1]?.trim() ?? "";
          const referencedPage = parseInt(match[2] ?? "0", 10);
          const x = lineItems[0]?.x ?? 0;
          if (heading && !skipHeadings.includes(heading)) {
            tocLines.push({ text: heading, x, pageNum: referencedPage });
          }
        }
      }
    }

    if (tocLines.length === 0) {
      log.info("TOC Tier 2: no dot-leader lines found");
      return null;
    }

    const referencedPages = tocLines.map((l) => l.pageNum);
    const minPage = Math.min(...referencedPages);
    const maxPage = Math.max(...referencedPages);
    const pageRange = maxPage - minPage;

    log.info("TOC Tier 2: page number range check", {
      minPage,
      maxPage,
      pageRange,
    });

    if (pageRange < 10) {
      log.warn(
        "TOC Tier 2: page number range too narrow — likely content page not TOC, falling through to Tier 3",
        { minPage, maxPage, pageRange },
      );
      return null;
    }

    const minX = Math.min(...tocLines.map((l) => l.x));
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

  // §4.4 Tier 3: if exactly one top-level heading, promote subsections if ≥ 2 exist.
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

async function extractToc(
  pdfPath: string,
  pdfBase64: string,
  headingPrompt: string,
  skipHeadings: string[],
  log: StageLogger,
): Promise<TocResult> {
  const tier1 = await extractTocFromBookmarks(pdfPath, skipHeadings, log);
  if (tier1 !== null) {
    log.info("TOC: Tier 1 succeeded", { headings: tier1.length });
    return { headings: tier1, tier: 1, inputTokens: 0, outputTokens: 0 };
  }

  const tier2 = await extractTocFromDotLeaders(pdfPath, skipHeadings, log);
  if (tier2 !== null) {
    log.info("TOC: Tier 2 succeeded", { headings: tier2.length });
    return { headings: tier2, tier: 2, inputTokens: 0, outputTokens: 0 };
  }

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

// ─── Single-pass: PDF (base64 inline) ────────────────────────────────────────

async function singlePassPdf(
  pdfPath: string,
  systemPrompt: string,
  outDir: string,
  log: StageLogger,
): Promise<number> {
  const source = basename(pdfPath);
  log.info("Single pass (PDF): encoding", { source });

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
  log.info("Single pass (PDF): parsed chunks", {
    source,
    count: rawChunks.length,
  });

  let written = 0;
  for (const raw of rawChunks) {
    const chunk = injectChunkMetadata(raw, source);
    await writeChunkFile(chunk, outDir);
    written++;
  }

  log.info("Single pass (PDF): complete", { source, written });
  return written;
}

// ─── Single-pass: Text (DOCX / MD / TXT) ─────────────────────────────────────

async function singlePassText(
  filePath: string,
  text: string,
  systemPrompt: string,
  outDir: string,
  log: StageLogger,
): Promise<number> {
  const source = basename(filePath);
  log.info("Single pass (text): sending to LLM", {
    source,
    chars: text.length,
  });

  const result = await withBackoff(
    () =>
      callLlm(
        {
          system: systemPrompt,
          prompt:
            "Read the following document carefully. Extract ALL distinct procedures/sections. " +
            "Return chunks in the XML format specified.\n\n" +
            text,
        },
        log,
      ),
    log,
  );

  const rawChunks = parseXmlResponse(result.text);
  log.info("Single pass (text): parsed chunks", {
    source,
    count: rawChunks.length,
  });

  let written = 0;
  for (const raw of rawChunks) {
    const chunk = injectChunkMetadata(raw, source);
    await writeChunkFile(chunk, outDir);
    written++;
  }

  log.info("Single pass (text): complete", { source, written });
  return written;
}

// ─── DOCX text extraction ─────────────────────────────────────────────────────

async function extractDocxText(filePath: string): Promise<string> {
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value;
}

// ─── Two-pass extraction (inline mode — use_files_api: false) ─────────────────

async function twoPassInline(
  pdfPath: string,
  systemPrompt: string,
  headingPrompt: string,
  outDir: string,
  log: StageLogger,
): Promise<number> {
  const source = basename(pdfPath);
  log.info("Two pass (inline): starting", { source });

  const pdfBase64 = await toBase64(pdfPath);

  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  const skipHeadings = CONFIG.chunks.skip_headings;
  const toc = await extractToc(
    pdfPath,
    pdfBase64,
    headingPrompt,
    skipHeadings,
    log,
  );

  totalInputTokens += toc.inputTokens;
  totalOutputTokens += toc.outputTokens;

  log.info("Two pass (inline): TOC extraction complete", {
    source,
    tier: toc.tier,
    headings: toc.headings.length,
  });

  const headings = toc.headings;

  // Fallback: no headings → full document call
  if (headings.length === 0) {
    log.warn(
      "Two pass (inline): no headings found — falling back to full document call",
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

    log.info("Two pass (inline): token summary", {
      source,
      totalInputTokens,
      totalOutputTokens,
    });
    log.info("Two pass (inline) fallback: complete", { source, written });
    return written;
  }

  log.info("Two pass (inline): headings found", {
    source,
    count: headings.length,
  });

  const delayMs = CONFIG.chunks.section_delay_seconds * 1000;
  let totalWritten = 0;

  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i]!;
    const nextHeading = headings[i + 1];
    const isLast = i === headings.length - 1;

    const sectionPrompt = isLast
      ? `Extract and format the section '${heading}' to the end of the document`
      : `Extract and format the section '${heading}' ending before '${nextHeading}'`;

    log.info("Two pass (inline): processing section", {
      source,
      section: i + 1,
      of: headings.length,
      heading,
    });

    const result = await withBackoff(
      () =>
        callLlm(
          { system: systemPrompt, prompt: sectionPrompt, pdfBase64 },
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

    log.info("Two pass (inline): section complete", {
      source,
      heading,
      chunksFromSection: rawChunks.length,
    });

    if (!isLast) {
      log.info(
        `Two pass (inline): waiting ${CONFIG.chunks.section_delay_seconds}s before next section`,
      );
      await new Promise<void>((r) => setTimeout(r, delayMs));
    }
  }

  log.info("Two pass (inline): token summary", {
    source,
    totalInputTokens,
    totalOutputTokens,
  });
  log.info("Two pass (inline): complete", { source, totalWritten });
  return totalWritten;
}

// ─── Two-pass extraction (file-reference mode — use_files_api: true) ──────────
// Uploads the PDF once, references by file_id on all calls, deletes in finally.

async function twoPassFileRef(
  pdfPath: string,
  systemPrompt: string,
  headingPrompt: string,
  outDir: string,
  log: StageLogger,
): Promise<number> {
  const source = basename(pdfPath);
  log.info("Two pass (file-reference): starting", { source });

  // Upload PDF to Files API
  const fileData = await readFile(pdfPath);
  const form = new FormData();
  form.append(
    "file",
    new Blob([fileData], { type: "application/pdf" }),
    source,
  );
  form.append("purpose", "assistants");

  const uploadResp = await fetch(
    `${process.env.AZURE_OPENAI_ENDPOINT}/openai/files?api-version=${process.env.AZURE_API_VERSION ?? "2024-12-01-preview"}`,
    {
      method: "POST",
      headers: { "api-key": process.env.AZURE_API_KEY ?? "" },
      body: form,
    },
  );

  if (!uploadResp.ok) {
    const body = await uploadResp.text();
    throw new Error(`Files API upload failed: ${uploadResp.status} ${body}`);
  }

  const uploadData = (await uploadResp.json()) as { id: string };
  const fileId = uploadData.id;
  log.info("Two pass (file-reference): uploaded PDF", { source, fileId });

  // Helper: delete file from Files API (called in finally)
  async function deleteFileFromApi(): Promise<void> {
    try {
      const delResp = await fetch(
        `${process.env.AZURE_OPENAI_ENDPOINT}/openai/files/${fileId}?api-version=${process.env.AZURE_API_VERSION ?? "2024-12-01-preview"}`,
        {
          method: "DELETE",
          headers: { "api-key": process.env.AZURE_API_KEY ?? "" },
        },
      );
      if (!delResp.ok) {
        log.warn("Files API delete returned non-OK", {
          fileId,
          status: delResp.status,
        });
      } else {
        log.info("Two pass (file-reference): deleted file from Files API", {
          fileId,
        });
      }
    } catch (err) {
      log.warn("Files API delete failed", { fileId, error: String(err) });
    }
  }

  let totalWritten = 0;

  try {
    const skipHeadings = CONFIG.chunks.skip_headings;

    // Pass 1: TOC extraction using file_id via Tier 3 (LLM)
    // For file-reference mode, we send the file_id reference instead of base64.
    // Here we use a special empty pdfBase64 and inject the file_id via prompt.
    const pdfBase64 = await toBase64(pdfPath); // used for Tier 1/2 (local)
    const toc = await extractToc(
      pdfPath,
      pdfBase64,
      headingPrompt,
      skipHeadings,
      log,
    );
    const headings = toc.headings;

    log.info("Two pass (file-reference): TOC extraction complete", {
      source,
      tier: toc.tier,
      headings,
      headingsCount: headings.length,
    });

    // Fallback: no headings → full document call using file_id
    if (headings.length === 0) {
      log.warn(
        "Two pass (file-reference): no headings found — falling back to full document call",
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

      const rawChunks = parseXmlResponse(result.text);
      for (const raw of rawChunks) {
        const chunk = injectChunkMetadata(raw, source);
        await writeChunkFile(chunk, outDir);
        totalWritten++;
      }

      log.info("Two pass (file-reference) fallback: complete", {
        source,
        written: totalWritten,
      });
      return totalWritten;
    }

    const delayMs = CONFIG.chunks.section_delay_seconds * 1000;

    for (let i = 0; i < headings.length; i++) {
      const heading = headings[i]!;
      const nextHeading = headings[i + 1];
      const isLast = i === headings.length - 1;

      const sectionPrompt = isLast
        ? `Extract and format the section '${heading}' to the end of the document`
        : `Extract and format the section '${heading}' ending before '${nextHeading}'`;

      log.info("Two pass (file-reference): processing section", {
        source,
        section: i + 1,
        of: headings.length,
        heading,
      });

      const result = await withBackoff(
        () =>
          callLlm(
            { system: systemPrompt, prompt: sectionPrompt, pdfBase64 },
            log,
          ),
        log,
      );

      const rawChunks = parseXmlResponse(result.text);
      for (const raw of rawChunks) {
        const chunk = injectChunkMetadata(raw, source);
        await writeChunkFile(chunk, outDir);
        totalWritten++;
      }

      log.info("Two pass (file-reference): section complete", {
        source,
        heading,
        chunksFromSection: rawChunks.length,
      });

      if (!isLast) {
        log.info(
          `Two pass (file-reference): waiting ${CONFIG.chunks.section_delay_seconds}s`,
        );
        await new Promise<void>((r) => setTimeout(r, delayMs));
      }
    }
  } finally {
    // §4.3: Always delete the uploaded file, whether the section loop succeeded or failed.
    await deleteFileFromApi();
  }

  log.info("Two pass (file-reference): complete", { source, totalWritten });
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
  const singlePassFormats = CONFIG.chunks.single_pass_formats.map((f) =>
    f.toLowerCase(),
  );
  const twoPassFormats = CONFIG.chunks.two_pass_formats.map((f) =>
    f.toLowerCase(),
  );

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
    log.warn("Input directory not readable — no files to process", {
      inputDir,
    });
    return { doc_type, processed: [], skipped: [], chunks_written: 0 };
  }

  // Filter to supported formats only
  const supportedFiles = allFiles
    .filter((f) => {
      const ext = getExt(f);
      return singlePassFormats.includes(ext) || twoPassFormats.includes(ext);
    })
    .sort();

  if (supportedFiles.length === 0) {
    log.info("No supported files found in input directory", {
      doc_type,
      inputDir,
    });
    return { doc_type, processed: [], skipped: [], chunks_written: 0 };
  }

  log.info("Files to process", { doc_type, count: supportedFiles.length });

  const processed: string[] = [];
  const skipped: string[] = [];
  let chunks_written = 0;

  for (const filename of supportedFiles) {
    const filePath = join(inputDir, filename);
    const ext = getExt(filename);
    log.info("Processing file", { filename, ext });

    try {
      const sizeKb = await fileSizeKb(filePath);
      log.info("File size", { filename, sizeKb: Math.round(sizeKb) });

      let written: number;

      if (sizeKb > thresholdKb) {
        // Large file path
        if (twoPassFormats.includes(ext)) {
          // PDF two-pass
          const validation = await validatePdf(filePath, log);
          if (!validation.valid) {
            log.error("PDF validation failed — skipping", {
              filename,
              reason: validation.reason,
            });
            skipped.push(filename);
            continue;
          }

          if (CONFIG.chunks.use_files_api) {
            written = await twoPassFileRef(
              filePath,
              systemPrompt,
              headingPrompt,
              outDir,
              log,
            );
          } else {
            written = await twoPassInline(
              filePath,
              systemPrompt,
              headingPrompt,
              outDir,
              log,
            );
          }
        } else {
          // Large file in a format that doesn't support two-pass
          log.warn(
            "File exceeds threshold but format not in two_pass_formats — skipping",
            {
              filename,
              sizeKb: Math.round(sizeKb),
              thresholdKb,
              ext,
            },
          );
          skipped.push(filename);
          continue;
        }
      } else {
        // Small file path — single-pass
        if (ext === "pdf") {
          const validation = await validatePdf(filePath, log);
          if (!validation.valid) {
            log.error("PDF validation failed — skipping", {
              filename,
              reason: validation.reason,
            });
            skipped.push(filename);
            continue;
          }
          written = await singlePassPdf(filePath, systemPrompt, outDir, log);
        } else if (ext === "docx") {
          // §4.1: DOCX — extract text, re-check expanded size
          const text = await extractDocxText(filePath);
          const expandedKb = Buffer.byteLength(text, "utf-8") / 1024;
          log.info("DOCX text extracted", {
            filename,
            expandedKb: Math.round(expandedKb),
          });

          if (expandedKb > thresholdKb) {
            log.warn("DOCX expanded text exceeds threshold — skipping", {
              filename,
              expandedKb: Math.round(expandedKb),
              thresholdKb,
            });
            skipped.push(filename);
            continue;
          }
          written = await singlePassText(
            filePath,
            text,
            systemPrompt,
            outDir,
            log,
          );
        } else {
          // MD, TXT, and any other single_pass_formats
          const text = await readFile(filePath, "utf-8");
          written = await singlePassText(
            filePath,
            text,
            systemPrompt,
            outDir,
            log,
          );
        }
      }

      if (written === 0) {
        log.warn("File produced zero chunks — not archiving", { filename });
        skipped.push(filename);
      } else {
        chunks_written += written;
        processed.push(filename);
      }
    } catch (err) {
      log.error("File processing failed — skipping", {
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
