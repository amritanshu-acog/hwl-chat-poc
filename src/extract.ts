import { readFile, writeFile, mkdir, readdir, stat } from "fs/promises";
import { join, resolve, extname, basename } from "path";
import { extractChunksFromDocument } from "./llm-client.js";
import type { GuideEntry, LLMChunkOutput } from "./schemas.js";

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

const GUIDE_PATH = join(process.cwd(), "data", "guide.yaml");

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
              m[1].trim(),
            )
          : [];

        // Parse related_chunks — same approach
        const relatedSection = block.match(
          /\n\s+related_chunks:\s*\n((?:\s+- .+\n?)*)/,
        );
        const related_chunks = relatedSection?.[1]
          ? [...relatedSection[1].matchAll(/- (.+?)\s*$/gm)].map((m) =>
              m[1].trim(),
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

// ─── Source readers ────────────────────────────────────────────────────────────

async function readPdf(filePath: string): Promise<string> {
  console.log(`📄 Reading PDF: ${filePath}`);
  const buf = await readFile(filePath);
  return buf.toString("base64");
}

// ─── Core extraction pipeline ──────────────────────────────────────────────────

async function extractSingle(
  source: string,
  outputDir: string,
): Promise<number> {
  const content = await readPdf(source);
  console.log(`  ↳ PDF size: ${content.length} base64 chars\n`);

  const chunks = await extractChunksFromDocument(content);

  if (chunks.length === 0) {
    console.log("  ⚠️  No chunks extracted from this document.\n");
    return 0;
  }

  const guide = await loadGuide();
  let savedCount = 0;

  for (const chunk of chunks) {
    try {
      const fileName = `${chunk.chunk_id}.md`;
      const filePath = join(outputDir, fileName);
      const relPath = `data/chunks/${fileName}`;

      // Assemble and write the .md chunk file
      const markdown = assembleChunkMarkdown(chunk);
      await writeFile(filePath, markdown, "utf-8");

      // Upsert into guide index
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
      } else {
        guide.push(entry);
        console.log(`  ✓ Created: ${fileName}`);
      }

      console.log(`    Topic:   ${chunk.topic}`);
      console.log(`    Summary: ${chunk.summary}`);
      console.log(`    Triggers: ${chunk.triggers.length}`);
      console.log(`    Images:  ${chunk.image_descriptions.length}`);
      console.log(`    Conditions: ${chunk.has_conditions}`);
      console.log("");

      savedCount++;
    } catch (error) {
      console.error(`  ✗ Failed to save chunk "${chunk.chunk_id}":`, error);
    }
  }

  await saveGuide(guide);
  return savedCount;
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

// ─── CLI Entry Point ───────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(`
Usage:
  bun run extract <source> [source2] ...

Sources:
  • A single PDF file      bun run extract ./manual.pdf
  • Multiple PDFs          bun run extract a.pdf b.pdf
  • A directory (all PDFs) bun run extract ./docs/
  • Mixed                  bun run extract ./docs/ extra.pdf
`);
    process.exit(1);
  }

  try {
    const sources = await resolveSources(args);

    if (sources.length === 0) {
      console.error("❌ No valid PDF sources found.");
      process.exit(1);
    }

    console.log(
      `\n🚀 Starting extraction for ${sources.length} source(s)...\n`,
    );

    const outputDir = join(process.cwd(), "data", "chunks");
    await mkdir(outputDir, { recursive: true });

    // Ensure data dir exists for guide.yaml
    await mkdir(join(process.cwd(), "data"), { recursive: true });

    let totalSaved = 0;

    for (let i = 0; i < sources.length; i++) {
      const source = sources[i]!;
      const label = basename(source);
      console.log(`\n━━━ [${i + 1}/${sources.length}] ${label} ━━━\n`);

      try {
        const count = await extractSingle(source, outputDir);
        totalSaved += count;
      } catch (err) {
        console.error(`❌ Failed to extract from ${label}:`, err);
      }
    }

    console.log(
      `\n✅ Extraction complete — ${totalSaved} chunk(s) saved to ${outputDir}\n`,
    );
    console.log(`📘 Guide index: data/guide.yaml\n`);
  } catch (error) {
    console.error("Extraction failed:", error);
    process.exit(1);
  }
}

main();
