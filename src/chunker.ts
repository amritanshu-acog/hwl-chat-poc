import { createHash } from "crypto";
import { basename } from "path";
import { CONFIG } from "./config.js";
import { logger } from "./logger.js";

export interface DocumentSegment {
  index: number;
  headingPath: string[];
  content: string;
  pageRange: { start: number; end: number };
  stableChunkId: string;
}

/** Slugify text into lowercase-hyphen form. */
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
 * Derive a stable chunk ID: `{slug}-{8-char hash}`.
 * Hash input is `basename(source) + topic` — deterministic per document+topic.
 */
export function deriveChunkId(
  source: string,
  topic: string,
  llmSlug?: string,
): string {
  const shortHash = createHash("sha256")
    .update(basename(source) + topic)
    .digest("hex")
    .slice(0, 8);
  return `${slugify(llmSlug ?? topic)}-${shortHash}`;
}

/** Derive a stable ID for a DocumentSegment (used for temp file naming only). */
function deriveSegmentId(headingPath: string[], content: string): string {
  const base = headingPath
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 60);
  const hash = createHash("sha256")
    .update(content.trim())
    .digest("hex")
    .substring(0, 8);
  return (base ? `${base}-${hash}` : hash).replace(/-{2,}/g, "-");
}

// ─── Table of Contents extraction ────────────────────────────────────────────
//
// The PDF ToC is a two-level outline where indentation encodes heading level:
//
//   Extensions                                              64   ← indent=0  BLUE topic heading
//       Account manager trying to edit extensions          64   ← indent>0  black Q&A item
//       Processing of Extensions (Locums)                  64   ← indent>0  black Q&A item
//   Requisitions                                           66   ← indent=0  BLUE topic heading
//       DNU for providers                                  66   ← indent>0  black Q&A item
//
// Strategy:
//   1. Scan the raw lines (NOT trimmed) inside the ToC block.
//   2. Measure leading whitespace of every ToC entry line.
//   3. The MINIMUM indent across all entries = level 0 = blue topic headings.
//   4. Only those minimum-indent entries go into the split whitelist.
//   5. All indented entries (Q&A items) are excluded — they must NOT trigger splits.
//
// This is the correct fix for the bug where "Approved timecards are stuck..."
// (an indented Q&A item) was incorrectly splitting the "Expenses" segment.

const TOC_HEADER_RE = /^(contents|table of contents)$/i;
const SKIP_ENTRY_RE = /^(important links|frequently asked questions)$/i;

// Matches a raw ToC line: optional leading spaces, text, 2+ spaces, page number
// Tested against the RAW line to preserve leading whitespace for indent measurement
const TOC_ENTRY_RE = /^(\s*)(.+?)\s{2,}(\d+)\s*$/;

/**
 * Parse the ToC and return only the TOP-LEVEL (left-aligned / blue) headings.
 * Returns a Set<string> of heading texts at the minimum indentation level.
 */
function extractTocHeadings(text: string): Set<string> {
  const lines = text.split("\n");

  // Pass 1: collect all ToC entry lines with their raw leading-space count
  interface TocLine {
    indent: number;
    text: string;
  }
  const tocLines: TocLine[] = [];

  let inToc = false;
  let consecutiveNonMatches = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!inToc) {
      if (TOC_HEADER_RE.test(trimmed)) inToc = true;
      continue;
    }

    // Form-feed or page-break marker = end of ToC
    if (/^\f/.test(line) || trimmed.includes("<<<PAGE_BREAK>>>")) break;
    // "-- N of M --" page footer = end of ToC
    if (/^--\s*\d+/.test(trimmed)) break;
    // Skip blank lines but don't count them as non-matches
    if (trimmed === "") continue;

    const match = TOC_ENTRY_RE.exec(line);
    if (match) {
      const indent = match[1]!.length; // raw leading space count
      const heading = match[2]!.trim();
      if (!TOC_HEADER_RE.test(heading) && !SKIP_ENTRY_RE.test(heading)) {
        tocLines.push({ indent, text: heading });
      }
      consecutiveNonMatches = 0;
    } else {
      consecutiveNonMatches++;
      // After 3 consecutive unrecognised lines, assume ToC has ended
      if (consecutiveNonMatches > 3) break;
    }
  }

  if (tocLines.length === 0) {
    logger.warn(
      "[chunker] No ToC entries detected — falling back to no split whitelist",
    );
    return new Set();
  }

  // Pass 2: determine the minimum indent = blue / top-level headings
  const minIndent = Math.min(...tocLines.map((l) => l.indent));

  // Allow ±1 char tolerance for minor pdf-parse spacing inconsistencies
  const INDENT_TOLERANCE = 1;
  const headings = new Set<string>(
    tocLines
      .filter((l) => l.indent <= minIndent + INDENT_TOLERANCE)
      .map((l) => l.text),
  );

  logger.debug("[chunker] ToC blue (left-aligned) headings extracted", {
    minIndent,
    count: headings.size,
    headings: [...headings],
  });

  return headings;
}

// ─── Page splitting ───────────────────────────────────────────────────────────

function splitIntoPages(text: string): string[] {
  const PAGE_BREAK_PATTERNS = [
    /\f/g,
    /\r?\n[-─═]{20,}\r?\n/g,
    /\r?\n\s*Page \d+\s*\r?\n/gi,
    /\r?\n[^\n]{3,60}\|[^\n]{5,30}\r?\n/g,
  ];

  let normalized = text;
  for (const pattern of PAGE_BREAK_PATTERNS) {
    normalized = normalized.replace(pattern, "\n<<<PAGE_BREAK>>>\n");
  }

  const pages = normalized
    .split("<<<PAGE_BREAK>>>")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (pages.length <= 1) {
    const lines = text.split("\n");
    const LINES_PER_PAGE = 300;
    const result: string[] = [];
    for (let i = 0; i < lines.length; i += LINES_PER_PAGE) {
      result.push(lines.slice(i, i + LINES_PER_PAGE).join("\n"));
    }
    return result.length > 0 ? result : [text];
  }

  return pages;
}

// ─── Preamble skip ────────────────────────────────────────────────────────────
//
// Discard all pages before the first blue topic heading appears in the body.
// This removes the ToC page(s) and any cover/intro material entirely.

function skipPreamblePages(pages: string[], tocHeadings: Set<string>): number {
  for (let i = 0; i < pages.length; i++) {
    for (const line of pages[i]!.split("\n")) {
      if (tocHeadings.has(line.trim())) return i;
    }
  }
  return 0; // fallback: keep everything
}

// ─── Noise line filter ────────────────────────────────────────────────────────

const NOISE_LINE_RE =
  /^(--|--\s*\d+\s*(of|\/)\s*\d+\s*--|contents|important links|frequently asked questions|\s*)$/i;

// ─── Core segmenter ──────────────────────────────────────────────────────────

const MIN_SEGMENT_CHARS = CONFIG.segmenter.minSegmentChars;
const MAX_SEGMENT_CHARS = CONFIG.segmenter.maxSegmentChars;

/**
 * Segment the FAQ into ONE segment per blue (left-aligned ToC) heading.
 *
 *  1. Parse ToC indentation → blue heading whitelist (left-aligned only).
 *  2. Skip preamble/ToC pages.
 *  3. Walk body lines. Exact match against whitelist → new segment.
 *  4. Everything else accumulates inside current segment.
 *  5. QnA extractor handles internal Q&A structure per segment.
 *
 * Expected output: ~20–30 segments for a 79-page FAQ.
 */
export function segmentDocument(
  text: string,
  docTitle = "document",
): DocumentSegment[] {
  // 1. Extract blue topic headings from ToC indentation
  const tocHeadings = extractTocHeadings(text);

  // 2. Split text into pages
  const allPages = splitIntoPages(text);

  // 3. Skip ToC / preamble pages
  const bodyStartIdx =
    tocHeadings.size > 0 ? skipPreamblePages(allPages, tocHeadings) : 0;
  const pages = allPages.slice(bodyStartIdx);

  const rootTitle =
    docTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .substring(0, 40) || "document";

  interface RawSegment {
    headingPath: string[];
    lines: string[];
    pageStart: number;
    pageEnd: number;
  }

  const rawSegments: RawSegment[] = [];
  let currentHeadingPath: string[] = [rootTitle];
  let currentLines: string[] = [];
  let currentPageStart = bodyStartIdx + 1;

  const flush = (pageEnd: number) => {
    const content = currentLines.join("\n").trim();
    if (content.length >= MIN_SEGMENT_CHARS) {
      rawSegments.push({
        headingPath: [...currentHeadingPath],
        lines: [...currentLines],
        pageStart: currentPageStart,
        pageEnd,
      });
    }
    currentLines = [];
  };

  pages.forEach((pageText, pageIdx) => {
    const pageNum = bodyStartIdx + pageIdx + 1;

    for (const line of pageText.split("\n")) {
      const trimmed = line.trim();

      // Drop structural noise (page footers etc.)
      if (NOISE_LINE_RE.test(trimmed)) continue;

      if (tocHeadings.has(trimmed)) {
        // Blue topic heading → close previous segment, open new one
        flush(pageNum);
        currentPageStart = pageNum;
        currentHeadingPath = [trimmed];
        currentLines = [line]; // include heading as first line for LLM context
      } else {
        // Black Q&A heading or body text → accumulate into current segment
        currentLines.push(line);
      }
    }
  });

  flush(pages.length + bodyStartIdx);

  // ── Merge segments that are too short ────────────────────────────────────

  const merged: RawSegment[] = [];
  for (const seg of rawSegments) {
    const content = seg.lines.join("\n").trim();
    if (merged.length > 0 && content.length < MIN_SEGMENT_CHARS) {
      const prev = merged[merged.length - 1]!;
      prev.lines.push(...seg.lines);
      prev.pageEnd = seg.pageEnd;
    } else {
      merged.push(seg);
    }
  }

  // ── Split segments that are excessively long ──────────────────────────────
  // Splits on blank lines only — never cuts mid-Q&A.

  const final: RawSegment[] = [];
  for (const seg of merged) {
    const content = seg.lines.join("\n").trim();
    if (content.length <= MAX_SEGMENT_CHARS) {
      final.push(seg);
      continue;
    }

    const paragraphs = content.split(/\n\s*\n/);
    let buffer: string[] = [];
    let bufLen = 0;
    let splitIdx = 0;

    for (const para of paragraphs) {
      if (bufLen + para.length > MAX_SEGMENT_CHARS && buffer.length > 0) {
        final.push({
          headingPath: [...seg.headingPath, `Part ${++splitIdx}`],
          lines: buffer,
          pageStart: seg.pageStart,
          pageEnd: seg.pageEnd,
        });
        buffer = [];
        bufLen = 0;
      }
      buffer.push(para);
      bufLen += para.length;
    }

    if (buffer.length > 0) {
      final.push({
        headingPath:
          splitIdx > 0
            ? [...seg.headingPath, `Part ${splitIdx + 1}`]
            : seg.headingPath,
        lines: buffer,
        pageStart: seg.pageStart,
        pageEnd: seg.pageEnd,
      });
    }
  }

  // ── Assign stable IDs and return ─────────────────────────────────────────

  return final.map((seg, idx) => {
    const content = seg.lines.join("\n").trim();
    return {
      index: idx,
      headingPath: seg.headingPath,
      content,
      pageRange: { start: seg.pageStart, end: seg.pageEnd },
      stableChunkId: deriveSegmentId(seg.headingPath, content),
    };
  });
}

// ─── PDF decode ───────────────────────────────────────────────────────────────

export async function decodePdfToText(base64: string): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  const buf = Buffer.from(base64, "base64");

  const MB = 1024 * 1024;
  if (buf.length > MB) {
    logger.warn("[chunker] Large document — text extraction may be slow", {
      sizeMB: (buf.length / MB).toFixed(1),
    });
  }

  try {
    const parser = new PDFParse(new Uint8Array(buf));
    const result = await parser.getText();
    const text = result.text ?? "";
    logger.info("[chunker] PDF text extracted", { chars: text.length });
    return text;
  } catch (err) {
    logger.warn(
      "[chunker] pdf-parse failed — falling back to LLM-only extraction",
      { error: err instanceof Error ? err.message : String(err) },
    );
    return "";
  }
}

// ─── Segment summary ──────────────────────────────────────────────────────────

export function logSegmentSummary(segments: DocumentSegment[]): void {
  logger.info("[chunker] Document segmented", {
    totalSegments: segments.length,
  });
  for (const seg of segments) {
    logger.debug("[chunker] Segment boundary", {
      index: seg.index,
      stableChunkId: seg.stableChunkId,
      heading: seg.headingPath.join(" › "),
      pageStart: seg.pageRange.start,
      pageEnd: seg.pageRange.end,
      chars: seg.content.length,
    });
  }
}
