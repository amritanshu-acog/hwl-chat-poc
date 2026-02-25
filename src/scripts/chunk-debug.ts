import { readFile, mkdir, writeFile } from "fs/promises";
import { join, parse } from "path";
import {
  decodePdfToText,
  segmentDocument,
  logSegmentSummary,
} from "../chunker.js";

async function main() {
  const targetPath = process.argv[2];
  if (!targetPath) {
    console.error("❌ Usage: bun run chunk <path/to/pdf>");
    process.exit(1);
  }

  console.log(`\n🔍 Starting Chunker Debug for: ${targetPath}`);

  // 1. Read PDF
  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await readFile(targetPath);
  } catch (err: any) {
    console.error(`❌ Could not read file: ${err.message}`);
    process.exit(1);
  }

  const pdfName = parse(targetPath).name;

  // 2. Decode to text
  console.log(`\n📄 Extracting text using pdf-parse...`);
  const text = await decodePdfToText(pdfBuffer.toString("base64"));

  if (!text.trim()) {
    console.error("❌ No text could be extracted from this PDF.");
    process.exit(1);
  }

  // 3. Segment the document
  console.log(`\n✂️  Segmenting document...`);
  const segments = segmentDocument(text, pdfName);

  // 4. Log the visual summary to terminal
  logSegmentSummary(segments);

  // 5. Write raw chunks to a debug folder
  const outputDir = join(process.cwd(), "data", "debug-chunks", pdfName);
  await mkdir(outputDir, { recursive: true });

  console.log(`💾 Saving explicit LLM inputs to: ${outputDir}`);

  for (const seg of segments) {
    const filename = `${seg.stableChunkId}.txt`;
    const outputPath = join(outputDir, filename);

    // Add some helpful visual context at the top of the file
    let fileContent = `--- DEBUG CHUNK METADATA ---\n`;
    fileContent += `Chunk ID: ${seg.stableChunkId}\n`;
    fileContent += `Heading Path: ${seg.headingPath.join(" > ")}\n`;
    fileContent += `Pages Spanned: ${seg.pageRange.start} to ${seg.pageRange.end}\n`;
    fileContent += `Character Count: ${seg.content.length}\n`;
    fileContent += `--- EXACT TEXT SENT TO LLM BELOW ---\n\n`;
    fileContent += seg.content;

    await writeFile(outputPath, fileContent, "utf-8");
  }

  console.log(
    `\n✅ Saved ${segments.length} segment(s) to disk. You can now read exactly what the LLM sees.`,
  );
}

main().catch((err) => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});
