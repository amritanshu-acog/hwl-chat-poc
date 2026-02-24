/**
 * src/chunker.ts
 *
 * Deterministic document boundary engine (GAP-D1-01).
 *
 * Problem solved:
 *   The previous pipeline sent the full raw PDF to the LLM and let it decide
 *   chunk boundaries. This is non-deterministic: same PDF → different chunk_ids
 *   on every run, making regression testing and stable chunk_id references
 *   impossible.
 *
 * Solution:
 *   1. Pre-segment the document by parsing structural signals BEFORE calling
 *      the LLM (headings, section markers, page breaks detected via pdf-parse).
 *   2. Generate a stable, content-derived chunk_id from the heading path +
 *      content hash so re-extraction of identical content always produces the
 *      same ID.
 *   3. Send each pre-bounded segment to the LLM individually to fill in the
 *      content fields — LLM no longer decides where to split, only what to say.
 *
 * Architecture:
 *   PDF (base64) → segmentDocument() → DocumentSegment[]
 *                                         ↓
 *                         for each segment → extractSegmentChunk() (LLM call)
 *                                         ↓
 *                              LLMChunkOutput[] (deterministic IDs)
 */

import { createHash } from "crypto";
import { CONFIG } from "./config.js";

// ─── Types ─────────────────────────────────────────────────────────────────────

/**
 * A pre-segmented portion of a document with stable boundaries derived from
 * structural signals (headings, page markers). The LLM fills in the semantic
 * content fields; it does NOT decide the boundaries.
 */
export interface DocumentSegment {
  /** Zero-based segment index — used for ordering */
  index: number;

  /**
   * Heading path that anchors this segment, e.g. ["Setup Guide", "Initial Login"].
   * Derived from PDF heading hierarchy. Used for deterministic chunk_id generation.
   */
  headingPath: string[];

  /**
   * Raw text content of this segment (may be partial PDF page text, heading, body).
   * Passed verbatim to the LLM as the extraction target.
   */
  content: string;

  /** Page range this segment spans, for position_hint in image descriptions */
  pageRange: { start: number; end: number };

  /**
   * Stable chunk_id derived deterministically from headingPath + content hash.
   * Same content → same ID across runs. Never changes unless content changes.
   */
  stableChunkId: string;
}

// ─── Chunk ID generator ───────────────────────────────────────────────────────

/**
 * Produce a deterministic chunk_id from heading path + content hash.
 *
 * Formula:
 *   base = heading path joined with '-', lowercased, non-alphanum replaced with '-'
 *   hash = first 8 chars of SHA256(content)
 *   result = `${base}-${hash}` (max 80 chars, trimmed)
 *
 * This ensures:
 *   - Same heading + same content → same ID (deterministic)
 *   - Different content → different ID (change detection)
 *   - Human-readable prefix from headings
 */
export function deriveChunkId(headingPath: string[], content: string): string {
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

  const raw = base ? `${base}-${hash}` : hash;
  return raw.replace(/-{2,}/g, "-");
}

// ─── Text-based document segmenter ───────────────────────────────────────────

/**
 * Heading detector — tuned for HWL-style PDFs.
 *
 * HWL documents use bold mixed-case headings with a trailing dash, e.g.:
 *   "Manual selection-"
 *   "Default selection-"
 * They also have a large centered page title like "Update Email Preferences".
 * They do NOT use markdown or ALL-CAPS headings (though those are kept for
 * other doc types in the same pipeline).
 *
 * Matched (real headings):
 *   "Manual selection-"           — HWL section style: mixed-case + trailing dash
 *   "Default selection-"          — same
 *   "Update Email Preferences"    — title-cased page title, short, no punctuation
 *   "## Setup Guide"              — markdown (kept for other doc types)
 *   "1. Initial Setup"            — top-level numbered section
 *   "STAFF POOL OVERVIEW"         — ALL CAPS 2+ words (kept for other doc types)
 *
 * NOT matched (steps / body text):
 *   "Upload CV/Resume."           — ends with period
 *   "From the HWL menu..."        — starts with preposition
 *   "Select 'OK' to the pop-up"  — step instruction
 *   "Click Save from the..."      — action-verb starter
 *   "A blue check mark means..."  — descriptive sentence
 *   "Depending on what actions..."— body continuation
 */
function isHeadingLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 100) return false;

  // ── Pre-filter: always reject these patterns ────────────────────────────────

  // Reject HWL page header/footer: "Staff Pool V3 | October 2025"
  if (/\|/.test(trimmed)) return false;

  // Reject standalone page numbers
  if (/^\d+$/.test(trimmed)) return false;

  // Reject table header rows — these appear as short consecutive title-case
  // words with no punctuation that map to column names, e.g. "Icon Name Action"
  // Heuristic: exactly 3 single-word tokens all title-case and all <= 8 chars each
  // (real section headings are longer or contain prepositions/connectors)
  const tableHeaderWords = trimmed.split(/\s+/);
  if (
    tableHeaderWords.length === 3 &&
    tableHeaderWords.every((w) => /^[A-Z][a-z]*$/.test(w) && w.length <= 8)
  )
    return false;

  // ── Rule 1: Markdown-style headings ────────────────────────────────────────
  if (/^#{1,3}\s+\S/.test(trimmed)) return true;

  // ── Rule 2: HWL-style "Section name-" headings ─────────────────────────────
  // Pattern: starts with uppercase, mixed-case words, ends with a single dash.
  // 2–6 words, not starting with a step-verb or preposition.
  if (/^[A-Z][a-zA-Z]+([ ][a-zA-Z]+){1,5}-$/.test(trimmed)) {
    const STEP_STARTERS =
      /^(from|select|click|go|move|enter|upload|add|use|open|close|check|ensure|note|if|once|after|then|when|depending|a |an |the )/i;
    if (!STEP_STARTERS.test(trimmed)) return true;
  }

  // ── Rule 3: ALL-CAPS section titles ────────────────────────────────────────
  // 2+ words, ≤ 60 chars, no end punctuation.
  const words = trimmed.split(/\s+/);
  if (
    trimmed === trimmed.toUpperCase() &&
    /[A-Z]/.test(trimmed) &&
    words.length >= 2 &&
    trimmed.length <= 60 &&
    !/[.,;:!?)]$/.test(trimmed)
  ) {
    return true;
  }

  // ── Rule 4: Top-level numbered sections "1. Title" ─────────────────────────
  // NOT sub-steps like "1.1" or "1.a". Title must be uppercase-initial, short.
  if (/^\d+\.\s+[A-Z][a-zA-Z\s]{3,40}$/.test(trimmed) && words.length <= 6) {
    return true;
  }

  // ── Rule 5: Title-case section headings ────────────────────────────────────
  // Covers blue bold HWL headings like "Add Candidate to Staff Pool",
  // "Confirmation Mgmt Actions", "Update Credentialing Documents".
  // Minimum 3 words to avoid matching 2-word table cells like
  // "Abort Agreement", "Contract Type", "Agreement Schedule".
  if (
    trimmed.length <= 80 &&
    words.length >= 3 &&
    words.length <= 9 &&
    !/[.,;:!?)\-]$/.test(trimmed) &&
    isTitleCase(trimmed)
  ) {
    const STEP_STARTERS =
      /^(from|select|click|go|move|enter|use|open|close|check|ensure|note|if|once|after|then|when|a |an |the |items |only|located|as |for |click|scroll|once|update the)/i;
    if (!STEP_STARTERS.test(trimmed)) return true;
  }

  return false;
}

/**
 * Returns true if the string looks like a title-cased phrase:
 * every word of 4+ letters starts uppercase, and no significant word
 * is all-lowercase (short prepositions like "of", "to" are tolerated).
 */
function isTitleCase(text: string): boolean {
  const words = text.split(/\s+/);
  let capitalised = 0;
  for (const w of words) {
    if (w.length >= 4 && /^[A-Z]/.test(w)) capitalised++;
    // A lowercase word of 4+ chars that isn't a common function word → not a title
    if (w.length >= 4 && /^[a-z]/.test(w)) return false;
  }
  return capitalised >= 1;
}

/**
 * Extract the heading text from a line.
 * Strips markdown prefix, leading numbering, section keywords,
 * and the trailing dash used in HWL-style headings.
 */
function extractHeadingText(line: string): string {
  return line
    .trim()
    .replace(/^#{1,4}\s+/, "")
    .replace(/^\d+(\.\d+)*\.?\s+/, "")
    .replace(/^(section|step|chapter|part|appendix)[\s:]+\d+[\s:]*/i, "")
    .replace(/-+$/, "") // strip trailing dash(es) — HWL heading style
    .trim();
}

// ─── Page-text extractor ──────────────────────────────────────────────────────

/**
 * Split raw document text into pseudo-pages using common page break markers
 * emitted by PDF text extractors. Falls back to fixed-line blocks if none found.
 */
function splitIntoPages(text: string): string[] {
  // Common page break markers from pdf-parse / pdfminer / pdftotext
  const PAGE_BREAK_PATTERNS = [
    /\f/g, // form feed character (most reliable — pdf-parse emits this)
    /\r?\n[-─═]{20,}\r?\n/g, // horizontal rule dividers
    /\r?\n\s*Page \d+\s*\r?\n/gi, // "Page N" markers
    /\r?\n\s*\d+\s*\r?\n(?=[A-Z])/, // standalone page numbers before uppercase
    // HWL-style footer pattern: line ending with "| Month YYYY" preceded by a
    // short doc-title line, e.g. "Staff Pool V3 | October 2025"
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

  // If no markers detected, split into 300-line blocks (approximate pages)
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

// ─── Core segmenter ─────────────────────────────────────────────────────────

const MIN_SEGMENT_CHARS = CONFIG.segmenter.minSegmentChars; // merge short fragments until this size
const MAX_SEGMENT_CHARS = CONFIG.segmenter.maxSegmentChars; // split if segment exceeds this

/**
 * Segment a plain-text document into structurally bounded sections.
 *
 * @param text      Plain text extracted from the PDF
 * @param docTitle  Optional PDF filename (without extension) used as the root
 *                  heading when no structural headings are detected. Defaults
 *                  to "document". Makes chunk IDs meaningful:
 *                  "hwl-agency-staff-pool-v3-part-1-<hash>" instead of
 *                  "document-part-1-<hash>".
 */
export function segmentDocument(
  text: string,
  docTitle = "document",
): DocumentSegment[] {
  const pages = splitIntoPages(text);

  // Slugify the title for use in heading paths
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
  let currentPageStart = 1;

  // Helper: flush current accumulation to rawSegments
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
    const pageNum = pageIdx + 1;
    const lines = pageText.split("\n");

    for (const line of lines) {
      if (isHeadingLine(line)) {
        // Flush what we've accumulated so far
        flush(pageNum);
        currentPageStart = pageNum;

        const heading = extractHeadingText(line);
        if (!heading) continue;

        // Determine heading depth heuristically
        // Level 1: ALL CAPS or starts with single digit "1."
        // Level 2: starts with "1.1" or camel-case short heading
        // Default: push to current path at depth 2
        if (
          line.trim() === line.trim().toUpperCase() ||
          /^\d+\.\s+/.test(line.trim())
        ) {
          // Top-level heading → reset path
          currentHeadingPath = [heading];
        } else if (/^\d+\.\d+/.test(line.trim())) {
          // Sub-heading → keep parent, replace child
          currentHeadingPath = [currentHeadingPath[0] ?? "Document", heading];
        } else {
          // Ambiguous: keep at most 2 levels
          if (currentHeadingPath.length === 1) {
            currentHeadingPath = [currentHeadingPath[0]!, heading];
          } else {
            currentHeadingPath = [currentHeadingPath[0]!, heading];
          }
        }

        // Start new segment with heading as first line
        currentLines = [line];
      } else {
        currentLines.push(line);
      }
    }

    // End of page — don't flush yet (segment may span pages)
  });

  // Flush final segment
  flush(pages.length);

  // ── Post-process: merge short segments, split overly long ones ─────────────

  const merged: RawSegment[] = [];

  for (const seg of rawSegments) {
    const content = seg.lines.join("\n").trim();

    if (merged.length > 0 && content.length < MIN_SEGMENT_CHARS) {
      // Too short — merge into previous segment
      const prev = merged[merged.length - 1]!;
      prev.lines.push(...seg.lines);
      prev.pageEnd = seg.pageEnd;
    } else {
      merged.push(seg);
    }
  }

  // Split any segment that's excessively long
  const final: RawSegment[] = [];
  for (const seg of merged) {
    const content = seg.lines.join("\n").trim();
    if (content.length <= MAX_SEGMENT_CHARS) {
      final.push(seg);
      continue;
    }

    // Split on paragraph boundaries (double newlines)
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

  // ── Assign stable IDs and return ───────────────────────────────────────────

  return final.map((seg, idx) => {
    const content = seg.lines.join("\n").trim();
    return {
      index: idx,
      headingPath: seg.headingPath,
      content,
      pageRange: { start: seg.pageStart, end: seg.pageEnd },
      stableChunkId: deriveChunkId(seg.headingPath, content),
    };
  });
}

// ─── Decode base64 PDF to text ────────────────────────────────────────────────

/**
 * Decode a base64-encoded PDF buffer to plain text using pdf-parse.
 *
 * pdf-parse extracts the actual text layer from the PDF (fonts, glyphs, etc.)
 * — not the raw binary. This is required for segmentDocument() and
 * deriveChunkId() to work correctly.
 *
 * Falls back to a warning and empty string if pdf-parse fails (e.g. image-only PDF).
 */
export async function decodePdfToText(base64: string): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  const buf = Buffer.from(base64, "base64");

  const MB = 1024 * 1024;
  if (buf.length > MB) {
    console.warn(
      `⚠️  [chunker] Large document: ${(buf.length / MB).toFixed(1)} MB — ` +
        `text extraction may be slow.`,
    );
  }

  try {
    const parser = new PDFParse(new Uint8Array(buf));
    const result = await parser.getText();
    const text = result.text ?? "";
    console.log(`📐 [chunker] Extracted ${text.length} chars of text from PDF`);
    return text;
  } catch (err) {
    console.warn(
      `⚠️  [chunker] pdf-parse failed (image-only PDF?). Falling back to LLM-only extraction.`,
      err,
    );
    return "";
  }
}

// ─── Segment summary ──────────────────────────────────────────────────────────

/** Print a human-readable summary of segments for debugging. */
export function logSegmentSummary(segments: DocumentSegment[]): void {
  console.log(
    `\n📐 Document segmented into ${segments.length} boundary-anchored section(s):\n`,
  );
  for (const seg of segments) {
    console.log(`  [${seg.index}] ${seg.stableChunkId}`);
    console.log(`       Heading: ${seg.headingPath.join(" › ")}`);
    console.log(
      `       Pages:   ${seg.pageRange.start}–${seg.pageRange.end}  |  Chars: ${seg.content.length}`,
    );
  }
  console.log("");
}
