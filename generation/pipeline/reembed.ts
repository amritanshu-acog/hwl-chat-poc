import { readdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { CONFIG } from "../core/config.js";
import { makeLogger } from "../core/logger.js";
import { computeRelatedChunks } from "./related-chunks.js";

const log = makeLogger("reembed");
const finalDir = CONFIG.directories.final;
const guidePath = CONFIG.directories.guide;

// Read all .md files from final/
const files = (await readdir(finalDir)).filter((f) => f.endsWith(".md"));
const entries: any[] = [];

for (const filename of files) {
  const raw = await readFile(join(finalDir, filename), "utf-8");
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) continue;
  const fm = fmMatch[1]!;
  const get = (key: string) =>
    fm.match(new RegExp(`${key}:\\s*"?([^"\\n]+)"?`))?.[1]?.trim() ?? "";
  const triggers = [...fm.matchAll(/- "([^"]+)"/g)].map((m) => m[1]!);
  entries.push({
    chunk_id: get("chunk_id"),
    source: get("source"),
    topic: get("topic"),
    summary: get("summary"),
    triggers,
    has_conditions: get("has_conditions") === "true",
    related_chunks: [],
    status: get("status") || "active",
  });
}

log.info("Loaded entries", { count: entries.length });

const result = await computeRelatedChunks(entries, log);
const relatedMap = result.relatedMap;

for (const entry of entries) {
  entry.related_chunks = relatedMap.get(entry.chunk_id) ?? [];
}

// Rebuild guide.yaml
const lines: string[] = [];
for (const e of entries) {
  lines.push(`- chunk_id: ${e.chunk_id}`);
  lines.push(`  source: ${e.source}`);
  lines.push(`  topic: "${e.topic.replace(/"/g, "'")}"`);
  lines.push(`  summary: "${e.summary.replace(/"/g, "'")}"`);
  lines.push(`  triggers:`);
  for (const t of e.triggers) lines.push(`    - "${t.replace(/"/g, "'")}"`);
  lines.push(`  has_conditions: ${e.has_conditions}`);
  lines.push(
    `  related_chunks: [${e.related_chunks.map((id: string) => `"${id}"`).join(", ")}]`,
  );
  lines.push(`  status: ${e.status}`);
  lines.push("");
}

await writeFile(guidePath, lines.join("\n"), "utf-8");
log.info("guide.yaml rewritten with related_chunks", {
  entries: entries.length,
});
