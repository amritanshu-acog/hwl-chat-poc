/**
 * generation/src/pipeline/chunk.ts
 *
 * Chunk stage — §4 of the design spec.
 *
 * For each input PDF:
 *   - Small PDF (≤ threshold): single pass — base64 inline → LLM → .md files
 *   - Large PDF (> threshold): two pass — Files API upload → TOC → section loop
 *
 * Output: <uuid>.md files in output/chunk/<doc_type>/
 * The output directory is wiped at the start of every run.
 */

import { readdir, readFile, writeFile, rm, mkdir, stat } from "fs/promises";
import { join, basename } from "path";
import { CONFIG } from "../core/config.js";
import { makeLogger } from "../core/logger.js";
import {
  callLlm,
  callLlmWithFileId,
  callLlmJson,
  uploadPdfToFilesApi,
  deletePdfFromFilesApi,
  loadPromptFile,
} from "../core/llm.js";
import { withBackoff } from "../utils/backoff.js";
import {
  parseXmlResponse,
  injectChunkMetadata,
  assembleChunkMarkdown,
} from "../utils/xml-parser.js";
import type { StageLogger } from "../core/logger.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ChunkResult {
  doc_type: "procedure" | "qna";
  processed: string[]; // PDF filenames successfully chunked
  skipped: string[]; // PDF filenames that errored (logged and skipped)
  chunks_written: number; // total .md files written across all PDFs
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

// ─── TOC extraction via file_id (Tier 3) ─────────────────────────────────────

/**
 * §4.4 Tier 3 — LLM-based TOC extraction using an already-uploaded file_id.
 * No PDF bytes are sent — just the file reference.
 */
async function extractTocWithFileId(
  fileId: string,
  headingPrompt: string,
  skipHeadings: string[],
  log: StageLogger,
): Promise<string[]> {
  log.info("TOC extraction: calling LLM via file_id (Tier 3)");

  const result = await withBackoff(
    () =>
      callLlmWithFileId(
        {
          system: headingPrompt,
          prompt: "Extract all top-level section headings from this document.",
          fileId,
          model: CONFIG.models.chunk,
          temperature: 0,
          maxTokens: 2000,
        },
        log,
      ),
    log,
  );

  // Parse <sections><section><heading>...</heading></section></sections>
  const headings: string[] = [];
  const sectionMatches = [
    ...result.text.matchAll(/<section>([\s\S]*?)<\/section>/g),
  ];

  for (const match of sectionMatches) {
    const block = match[1] ?? "";
    const headingMatch = block.match(/<heading>([\s\S]*?)<\/heading>/);
    if (headingMatch) {
      const h = headingMatch[1]?.trim();
      if (h) headings.push(h);
    }
  }

  // §4.4 Tier 3: if exactly one top-level heading, promote subsections
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
      log.info("TOC: single top-level heading — promoting subsections", {
        count: subsections.length,
      });
      return subsections.filter((h) => !skipHeadings.includes(h));
    }
  }

  return headings.filter((h) => !skipHeadings.includes(h));
}

// ─── Single-pass extraction ────────────────────────────────────────────────────

/**
 * §4.2 Single Pass
 * Base64-encode the PDF → one LLM call → parse chunks → write .md files.
 */
async function singlePass(
  pdfPath: string,
  systemPrompt: string,
  outDir: string,
  log: StageLogger,
): Promise<number> {
  const source = basename(pdfPath);
  log.info("Single pass: encoding PDF", { source });

  const pdfBase64 = await toBase64(pdfPath);

  const userPrompt =
    "Read every page of this PDF carefully. Extract ALL distinct procedures/sections. " +
    "Return chunks in the XML format specified.";

  const result = await withBackoff(
    () => callLlm({ system: systemPrompt, prompt: userPrompt, pdfBase64 }, log),
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

// ─── Two-pass extraction ───────────────────────────────────────────────────────

/**
 * §4.3 Two Pass
 * Upload PDF once → TOC extraction → per-section LLM calls using file_id.
 * PDF bytes are sent only once (upload). Each section call uses file_id only.
 */
async function twoPass(
  pdfPath: string,
  systemPrompt: string,
  headingPrompt: string,
  outDir: string,
  log: StageLogger,
): Promise<number> {
  const source = basename(pdfPath);
  log.info("Two pass: starting", { source });

  // ── Upload PDF once ────────────────────────────────────────────────────────
  let fileId: string;
  try {
    fileId = await uploadPdfToFilesApi(pdfPath, log);
  } catch (err) {
    // Upload failed — fall back to base64 single call for the whole document
    log.warn(
      "Files API upload failed — falling back to base64 full-document call",
      {
        source,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    const pdfBase64 = await toBase64(pdfPath);
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
    let written = 0;
    for (const raw of rawChunks) {
      const chunk = injectChunkMetadata(raw, source);
      await writeChunkFile(chunk, outDir);
      written++;
    }
    log.info("Base64 fallback: complete", { source, written });
    return written;
  }

  // ── All further work in try/finally so file is always deleted ─────────────
  try {
    // TOC extraction using file_id (no PDF bytes sent)
    log.info(
      "TOC: Tier 1 (bookmarks) not available — trying Tier 3 (LLM via file_id)",
    );
    const headings = await extractTocWithFileId(fileId, headingPrompt, [], log);

    // §4.3 Fallback: no headings → single full-document call using file_id
    if (headings.length === 0) {
      log.warn(
        "Two pass: no headings found — falling back to single full-document call",
        {
          source,
        },
      );
      const result = await withBackoff(
        () =>
          callLlmWithFileId(
            {
              system: systemPrompt,
              prompt:
                "Read every page of this document. Extract ALL sections as chunks in the XML format specified.",
              fileId,
            },
            log,
          ),
        log,
      );
      const rawChunks = parseXmlResponse(result.text);
      let written = 0;
      for (const raw of rawChunks) {
        const chunk = injectChunkMetadata(raw, source);
        await writeChunkFile(chunk, outDir);
        written++;
      }
      log.info("Two pass fallback: complete", { source, written });
      return written;
    }

    log.info("Two pass: headings found", { source, count: headings.length });

    const delayMs = CONFIG.chunks.section_delay_seconds * 1000;
    let totalWritten = 0;

    // ── Per-section loop ───────────────────────────────────────────────────
    for (let i = 0; i < headings.length; i++) {
      const heading = headings[i]!;
      const nextHeading = headings[i + 1];
      const isLast = i === headings.length - 1;

      const userPrompt = isLast
        ? `Extract and format the section '${heading}' to the end of the document`
        : `Extract and format the section '${heading}' ending before '${nextHeading}'`;

      log.info("Two pass: processing section", {
        source,
        section: i + 1,
        of: headings.length,
        heading,
      });

      // Only file_id sent — no PDF bytes
      const result = await withBackoff(
        () =>
          callLlmWithFileId(
            { system: systemPrompt, prompt: userPrompt, fileId },
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

      log.info("Two pass: section complete", {
        source,
        heading,
        chunksFromSection: rawChunks.length,
      });

      // §4.3: No delay after the last section
      if (!isLast) {
        log.info(
          `Two pass: waiting ${CONFIG.chunks.section_delay_seconds}s before next section`,
        );
        await new Promise<void>((r) => setTimeout(r, delayMs));
      }
    }

    log.info("Two pass: complete", { source, totalWritten });
    return totalWritten;
  } finally {
    // §4.3: Always delete the uploaded file — success or failure
    await deletePdfFromFilesApi(fileId, log);
  }
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

  // ── Wipe output directory ─────────────────────────────────────────────────
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  log.info("Output directory wiped and recreated", { outDir });

  // ── Load prompts ──────────────────────────────────────────────────────────
  const systemPromptPath =
    doc_type === "procedure" ? CONFIG.prompts.procedure : CONFIG.prompts.qna;

  const systemPrompt = loadPromptFile(systemPromptPath);
  const headingPrompt = loadPromptFile(CONFIG.prompts.heading);

  // ── List PDFs ─────────────────────────────────────────────────────────────
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

  // ── Process each PDF ──────────────────────────────────────────────────────
  for (const filename of pdfs) {
    const pdfPath = join(inputDir, filename);
    log.info("Processing PDF", { filename });

    try {
      const sizeKb = await fileSizeKb(pdfPath);
      log.info("PDF size", { filename, sizeKb: Math.round(sizeKb) });

      let written: number;

      if (sizeKb <= thresholdKb) {
        // §4.2 Single pass
        written = await singlePass(pdfPath, systemPrompt, outDir, log);
      } else {
        // §4.3 Two pass
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
      // §4: Per-PDF errors — log and skip, continue with next PDF
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
