/**
 * generation/src/pipeline/delete.ts
 *
 * Delete stage — §9 of the design spec.
 *
 * Usage: bun generation/src/pipeline/delete.ts "My Document.pdf"
 *
 * 1. Load guide.yaml — find all chunks with source == <pdf_filename>
 * 2. If none found → return (no-op)
 * 3. Backup final/
 * 4. Delete chunk .md files from final/
 * 5. Rebuild guide.yaml
 * 6. Recompute related_chunks
 * 7. Write delete report to final/reports/<timestamp>.json
 */

import { readFile, writeFile, rm, mkdir, cp, readdir } from "fs/promises";
import { join } from "path";
import { CONFIG } from "../core/config.js";
import { makeLogger } from "../core/logger.js";
import { computeRelatedChunks } from "./related-chunks.js";
import type { GuideEntry } from "./compile.js";

// ─── Timestamp ────────────────────────────────────────────────────────────────

function makeTimestamp(): string {
  const now = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "_",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
}

// ─── Guide loader (lightweight) ───────────────────────────────────────────────

function loadGuideEntries(raw: string): GuideEntry[] {
  try {
    const entries: GuideEntry[] = [];
    const blocks = raw.split(/^- /m).filter((b) => b.trim());

    for (const block of blocks) {
      const lines = block.split("\n");
      const entry: Partial<GuideEntry> = { related_chunks: [], triggers: [] };
      let i = 0;

      while (i < lines.length) {
        const line = lines[i]!.trim();
        i++;
        if (!line) continue;

        const listMatch = line.match(/^(\w+):\s*$/);
        if (listMatch) {
          const key = listMatch[1]!;
          const items: string[] = [];
          while (i < lines.length && lines[i]!.startsWith("  ")) {
            items.push(
              lines[i]!.replace(/^\s*-\s*/, "")
                .replace(/^"(.*)"$/, "$1")
                .trim(),
            );
            i++;
          }
          (entry as any)[key] = items;
          continue;
        }

        const m = line.match(/^(\w+):\s*(.*)/);
        if (m) {
          const key = m[1]!;
          let val = (m[2] ?? "").replace(/^"(.*)"$/, "$1");
          if (val === "true") {
            (entry as any)[key] = true;
            continue;
          }
          if (val === "false") {
            (entry as any)[key] = false;
            continue;
          }
          if (val.startsWith("[") && val.endsWith("]")) {
            const inner = val.slice(1, -1).trim();
            (entry as any)[key] = inner
              ? inner.split(",").map((s) => s.trim().replace(/^"(.*)"$/, "$1"))
              : [];
            continue;
          }
          (entry as any)[key] = val;
        }
      }

      if (entry.chunk_id) entries.push(entry as GuideEntry);
    }

    return entries;
  } catch {
    return [];
  }
}

function serializeGuideYaml(entries: GuideEntry[]): string {
  const lines: string[] = [];
  for (const e of entries) {
    lines.push(`- chunk_id: ${e.chunk_id}`);
    lines.push(`  source: ${e.source}`);
    lines.push(`  topic: "${e.topic.replace(/"/g, "'")}"`);
    lines.push(`  summary: "${e.summary.replace(/"/g, "'")}"`);
    lines.push(`  triggers:`);
    for (const t of e.triggers) {
      lines.push(`    - "${t.replace(/"/g, "'")}"`);
    }
    lines.push(`  has_conditions: ${e.has_conditions}`);
    lines.push(
      `  related_chunks: [${e.related_chunks.map((id) => `"${id}"`).join(", ")}]`,
    );
    lines.push(`  status: ${e.status}`);
    lines.push("");
  }
  return lines.join("\n");
}

// ─── Backup ───────────────────────────────────────────────────────────────────

async function backupFinal(
  finalDir: string,
  backupDir: string,
  timestamp: string,
): Promise<void> {
  const dest = join(backupDir, timestamp);
  await mkdir(dest, { recursive: true });
  await cp(finalDir, dest, {
    recursive: true,
    filter: (src) =>
      (!src.includes("/backup/") && !src.includes("/reports/")) ||
      src === finalDir,
  });
}

// ─── Stage ────────────────────────────────────────────────────────────────────

export interface DeleteResult {
  success: boolean;
  source: string;
  removed: GuideEntry[];
  totalFinal: number;
  reportPath: string;
  error?: string;
}

export async function runDelete(sourceFilename: string): Promise<DeleteResult> {
  const log = makeLogger("delete");
  const timestamp = makeTimestamp();

  log.info("Delete stage started", { source: sourceFilename });

  const finalDir = CONFIG.directories.final;
  const backupDir = CONFIG.directories.final_backup;
  const reportsDir = CONFIG.directories.final_reports;
  const guidePath = CONFIG.directories.guide;

  // ── Load guide.yaml ────────────────────────────────────────────────────────
  let guideRaw: string;
  try {
    guideRaw = await readFile(guidePath, "utf-8");
  } catch {
    log.warn("guide.yaml not found — nothing to delete");
    return {
      success: true,
      source: sourceFilename,
      removed: [],
      totalFinal: 0,
      reportPath: "",
    };
  }

  const allEntries = loadGuideEntries(guideRaw);
  const toDelete = allEntries.filter((e) => e.source === sourceFilename);

  if (toDelete.length === 0) {
    log.info("No chunks found for source — no-op", { source: sourceFilename });
    return {
      success: true,
      source: sourceFilename,
      removed: [],
      totalFinal: allEntries.length,
      reportPath: "",
    };
  }

  log.info("Chunks to delete", {
    source: sourceFilename,
    count: toDelete.length,
  });

  // ── Backup final/ ─────────────────────────────────────────────────────────
  try {
    await backupFinal(finalDir, backupDir, timestamp);
    log.info("Backup complete", { timestamp });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error("Backup failed — aborting delete", { error });
    return {
      success: false,
      source: sourceFilename,
      removed: [],
      totalFinal: 0,
      reportPath: "",
      error,
    };
  }

  try {
    // ── Delete chunk files ────────────────────────────────────────────────
    for (const entry of toDelete) {
      const chunkFile = join(finalDir, `${entry.chunk_id}.md`);
      try {
        await rm(chunkFile);
        log.info("Deleted chunk", {
          chunk_id: entry.chunk_id,
          source: entry.source,
        });
      } catch (err) {
        log.warn("Could not delete chunk file", {
          chunk_id: entry.chunk_id,
          error: String(err),
        });
      }
    }

    // ── Rebuild guide.yaml ────────────────────────────────────────────────
    const remainingEntries = allEntries.filter(
      (e) => e.source !== sourceFilename,
    );

    // ── Recompute related_chunks ──────────────────────────────────────────
    let relatedResult: unknown = { error: "not computed" };
    try {
      const rc = await computeRelatedChunks(remainingEntries, log);
      relatedResult = rc;
      const relatedMap = rc.relatedMap;
      for (const entry of remainingEntries) {
        entry.related_chunks = relatedMap.get(entry.chunk_id) ?? [];
      }
    } catch (err) {
      log.warn("Related chunks failed — non-fatal", { error: String(err) });
      relatedResult = {
        error: err instanceof Error ? err.message : String(err),
      };
    }

    await writeFile(guidePath, serializeGuideYaml(remainingEntries), "utf-8");
    log.info("guide.yaml rebuilt", { remaining: remainingEntries.length });

    // ── Write delete report ───────────────────────────────────────────────
    await mkdir(reportsDir, { recursive: true });

    const report = {
      timestamp,
      action: "delete",
      source: sourceFilename,
      removed: toDelete,
      total_final: remainingEntries.length,
      related_chunks: relatedResult,
    };

    const reportPath = join(reportsDir, `${timestamp}.json`);
    await writeFile(reportPath, JSON.stringify(report, null, 2), "utf-8");

    log.info("Delete stage complete", {
      source: sourceFilename,
      removed: toDelete.length,
      total_final: remainingEntries.length,
      reportPath,
    });

    return {
      success: true,
      source: sourceFilename,
      removed: toDelete,
      totalFinal: remainingEntries.length,
      reportPath,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error("Delete stage failed", { error });
    return {
      success: false,
      source: sourceFilename,
      removed: [],
      totalFinal: 0,
      reportPath: "",
      error,
    };
  }
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

if (import.meta.main) {
  const source = process.argv[2];
  if (!source) {
    console.error(
      "Usage: bun generation/src/pipeline/delete.ts <pdf_filename>",
    );
    console.error(
      'Example: bun generation/src/pipeline/delete.ts "My Document.pdf"',
    );
    process.exit(1);
  }

  const result = await runDelete(source);
  if (result.success) {
    console.log(`✅ Deleted ${result.removed.length} chunk(s) for "${source}"`);
    console.log(`   Total remaining: ${result.totalFinal}`);
    if (result.reportPath) console.log(`   Report: ${result.reportPath}`);
  } else {
    console.error(`❌ Delete failed: ${result.error}`);
    process.exit(1);
  }
}
