import { readFile, writeFile, mkdir, readdir, stat } from "fs/promises";
import { join, resolve, extname, basename } from "path";
import fetch from "node-fetch";
import { extractProcessesFromDocument } from "./llm-client.js";
import { TroubleshootingProcessSchema } from "./schemas.js";

// ─── Source readers ────────────────────────────────────────────────────────────

/** Read a PDF file and return its base64 content */
async function readPdf(filePath: string): Promise<string> {
  console.log(`📄 Reading PDF: ${filePath}`);
  const buf = await readFile(filePath);
  return buf.toString("base64");
}

/** Fetch a URL and return cleaned plain-text content */
async function readUrl(url: string): Promise<string> {
  console.log(`🌐 Fetching URL: ${url}`);
  const res = await fetch(url);
  const html = await res.text();

  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Core extraction pipeline ──────────────────────────────────────────────────

/** Run extraction for a single source (PDF path or URL) and save results */
async function extractSingle(
  source: string,
  outputDir: string,
): Promise<number> {
  const isUrl = source.startsWith("http://") || source.startsWith("https://");
  const content = isUrl ? await readUrl(source) : await readPdf(source);

  console.log(`  ↳ Content size: ${content.length} chars\n`);

  const processes = await extractProcessesFromDocument(content, !isUrl);

  if (processes.length === 0) {
    console.log("  ⚠️  No processes found in this document.\n");
    return 0;
  }

  let savedCount = 0;

  for (const proc of processes) {
    try {
      // AI SDK already validates against the schema via Output.array(),
      // but we parse once more here to guarantee the file on disk is correct.
      const validated = TroubleshootingProcessSchema.parse(proc);
      const fileName = `${validated.processId}.json`;
      const filePath = join(outputDir, fileName);

      await writeFile(filePath, JSON.stringify(validated, null, 2), "utf-8");

      console.log(`  ✓ Saved: ${fileName}`);
      console.log(`    Name: ${validated.processName}`);
      console.log(`    Description: ${validated.description}`);
      console.log(`    Nodes: ${validated.nodes.length}`);
      console.log(`    Tags: ${validated.tags.join(", ")}\n`);
      savedCount++;
    } catch (error) {
      console.error(`  ✗ Failed to save process:`, error);
    }
  }

  return savedCount;
}

// ─── Input resolution ──────────────────────────────────────────────────────────

/** Given CLI arguments, resolve them into a flat list of sources (file paths / URLs) */
async function resolveSources(args: string[]): Promise<string[]> {
  const sources: string[] = [];

  for (const arg of args) {
    // URLs pass through directly
    if (arg.startsWith("http://") || arg.startsWith("https://")) {
      sources.push(arg);
      continue;
    }

    const resolved = resolve(arg);
    const info = await stat(resolved);

    if (info.isDirectory()) {
      // Scan directory for PDF files
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
      sources.push(resolved);
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
  bun run extract <source> [source2] [source3] ...

Sources can be:
  • A single PDF file path      bun run extract ./manual.pdf
  • Multiple PDF file paths     bun run extract a.pdf b.pdf c.pdf
  • A directory (all PDFs)      bun run extract ./docs/
  • A URL                       bun run extract https://example.com/guide
  • Mixed                       bun run extract ./docs/ extra.pdf https://example.com
`);
    process.exit(1);
  }

  try {
    const sources = await resolveSources(args);

    if (sources.length === 0) {
      console.error("❌ No valid sources found.");
      process.exit(1);
    }

    console.log(
      `\n🚀 Starting extraction for ${sources.length} source(s)...\n`,
    );

    // Ensure output directory exists
    const outputDir = join(process.cwd(), "data", "processes");
    await mkdir(outputDir, { recursive: true });

    let totalSaved = 0;

    for (let i = 0; i < sources.length; i++) {
      const source = sources[i]!;
      const label = source.startsWith("http") ? source : basename(source);

      console.log(`\n━━━ [${i + 1}/${sources.length}] ${label} ━━━\n`);

      try {
        const count = await extractSingle(source, outputDir);
        totalSaved += count;
      } catch (err) {
        console.error(`❌ Failed to extract from ${label}:`, err);
      }
    }

    console.log(
      `\n✅ Extraction complete! ${totalSaved} process(es) saved to ${outputDir}\n`,
    );
  } catch (error) {
    console.error("Extraction failed:", error);
    process.exit(1);
  }
}

main();
