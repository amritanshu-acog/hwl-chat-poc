/**
 * bun run delete <chunk_id>
 *
 * Deletes a chunk .md file by chunk_id and rebuilds guide.yaml.
 *
 * Example:
 *   bun run delete update-email-preferences-default
 */

import { unlink, access } from "fs/promises";
import { join } from "path";
import { execSync } from "child_process";

const CHUNKS_DIR = join(process.cwd(), "data", "chunks");

async function main() {
  const chunkId = process.argv[2];

  if (!chunkId) {
    console.log(`
Usage:
  bun run delete <chunk_id>

Example:
  bun run delete update-email-preferences-default
`);
    process.exit(1);
  }

  const filePath = join(CHUNKS_DIR, `${chunkId}.md`);

  // Check file exists
  try {
    await access(filePath);
  } catch {
    console.error(`❌ Chunk not found: ${filePath}`);
    console.error(`   Check the chunk_id is correct and the file exists.`);
    process.exit(1);
  }

  // Delete the chunk file
  await unlink(filePath);
  console.log(`\n🗑️  Deleted: data/chunks/${chunkId}.md`);

  // Rebuild guide.yaml from remaining chunks
  console.log(`\n🔨 Rebuilding guide.yaml...\n`);
  try {
    execSync("bun run rebuild", { stdio: "inherit" });
  } catch {
    console.error("❌ Guide rebuild failed. Run bun run rebuild manually.");
    process.exit(1);
  }

  console.log(`✅ Done. Chunk "${chunkId}" removed from knowledge base.\n`);
}

main().catch((err) => {
  console.error("❌ Delete failed:", err);
  process.exit(1);
});
