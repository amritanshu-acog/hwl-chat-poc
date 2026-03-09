/**
 * generation/pipeline/delete.ts
 *
 * Delete stage — §10 of the design spec.
 *
 * Two modes:
 *   Source-level: bun generation/pipeline/delete.ts "My Document.pdf"
 *   Chunk-level:  bun generation/pipeline/delete.ts --chunk <id> [<id> ...]
 *
 * Both modes:
 *   1. Load guide.yaml — identify chunks to remove
 *   2. Backup final/
 *   3. Delete chunk .md files from final/
 *   4. Rebuild guide.yaml
 *   5. Recompute related_chunks
 *   6. Write delete report to final/reports/<timestamp>.json
 *   7. Run Guide Quality check
 */

import { readFile, writeFile, rm, mkdir, copyFile, readdir } from "fs/promises";
import { join } from "path";
import { CONFIG } from "../core/config.js";
import { makeLogger } from "../core/logger.js";
import { computeRelatedChunks } from "./related-chunks.js";
import { runGuideQuality } from "./guide-quality.js";
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
// Mirrors compile.ts: copy only .md files and guide.yaml (no reports/).

async function backupFinal(
  finalDir: string,
  backupDir: string,
  timestamp: string,
): Promise<void> {
  const dest = join(backupDir, timestamp);
  await mkdir(dest, { recursive: true });

  const filesToBackup = (await readdir(finalDir)).filter(
    (f) => f.endsWith(".md") || f === "guide.yaml",
  );
  for (const f of filesToBackup) {
    await copyFile(join(finalDir, f), join(dest, f));
  }
}

// ─── Shared tail: backup → delete → rebuild → report → guide quality ─────────

async function deleteTail(
  action: "delete_source" | "delete_chunks",
  toDelete: GuideEntry[],
  allEntries: GuideEntry[],
  log: ReturnType<typeof makeLogger>,
): Promise<DeleteResult> {
  const timestamp = makeTimestamp();
  const finalDir = CONFIG.directories.final;
  const backupDir = CONFIG.directories.final_backup;
  const reportsDir = CONFIG.directories.final_reports;
  const guidePath = CONFIG.directories.guide;

  // ── Backup ────────────────────────────────────────────────────────────────
  try {
    await backupFinal(finalDir, backupDir, timestamp);
    log.info("Backup complete", { timestamp });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error("Backup failed — aborting delete", { error });
    return {
      success: false,
      action,
      removed: [],
      totalFinal: 0,
      reportPath: "",
      error,
    };
  }

  try {
    // ── Delete chunk files ──────────────────────────────────────────────────
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

    // ── Rebuild guide.yaml ──────────────────────────────────────────────────
    const deletedIds = new Set(toDelete.map((e) => e.chunk_id));
    const remainingEntries = allEntries.filter(
      (e) => !deletedIds.has(e.chunk_id),
    );

    // ── Recompute related_chunks ───────────────────────────────────────────
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

    // ── Write delete report ────────────────────────────────────────────────
    await mkdir(reportsDir, { recursive: true });

    // §16: delete report has no top-level "source"; source is inside each removed entry.
    const report = {
      timestamp,
      action,
      removed: toDelete,
      total_final: remainingEntries.length,
      related_chunks: relatedResult,
    };

    const reportPath = join(reportsDir, `${timestamp}.json`);
    await writeFile(reportPath, JSON.stringify(report, null, 2), "utf-8");

    log.info("Delete stage complete", {
      action,
      removed: toDelete.length,
      total_final: remainingEntries.length,
      reportPath,
    });

    // ── Guide Quality check ────────────────────────────────────────────────
    // §10: Runs automatically after every delete. Non-fatal.
    try {
      await runGuideQuality(log);
    } catch (err) {
      log.warn("Guide Quality check failed — non-fatal", {
        error: String(err),
      });
    }

    return {
      success: true,
      action,
      removed: toDelete,
      totalFinal: remainingEntries.length,
      reportPath,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error("Delete stage failed", { error });
    return {
      success: false,
      action,
      removed: [],
      totalFinal: 0,
      reportPath: "",
      error,
    };
  }
}

// ─── Result type ──────────────────────────────────────────────────────────────

export interface DeleteResult {
  success: boolean;
  action: "delete_source" | "delete_chunks";
  removed: GuideEntry[];
  totalFinal: number;
  reportPath: string;
  error?: string;
}

// ─── Source-level delete ──────────────────────────────────────────────────────

export async function runDelete(sourceFilename: string): Promise<DeleteResult> {
  const log = makeLogger("delete");
  log.info("Delete stage started (source-level)", { source: sourceFilename });

  const guidePath = CONFIG.directories.guide;

  let guideRaw: string;
  try {
    guideRaw = await readFile(guidePath, "utf-8");
  } catch {
    log.warn("guide.yaml not found — nothing to delete");
    return {
      success: true,
      action: "delete_source",
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
      action: "delete_source",
      removed: [],
      totalFinal: allEntries.length,
      reportPath: "",
    };
  }

  log.info("Chunks to delete", {
    source: sourceFilename,
    count: toDelete.length,
  });

  return deleteTail("delete_source", toDelete, allEntries, log);
}

// ─── Chunk-level delete ───────────────────────────────────────────────────────

export async function runDeleteChunks(
  chunkIds: string[],
): Promise<DeleteResult> {
  const log = makeLogger("delete");
  log.info("Delete stage started (chunk-level)", { chunk_ids: chunkIds });

  const guidePath = CONFIG.directories.guide;

  let guideRaw: string;
  try {
    guideRaw = await readFile(guidePath, "utf-8");
  } catch {
    log.warn("guide.yaml not found — nothing to delete");
    return {
      success: true,
      action: "delete_chunks",
      removed: [],
      totalFinal: 0,
      reportPath: "",
    };
  }

  const allEntries = loadGuideEntries(guideRaw);
  const idSet = new Set(chunkIds);

  // Warn about IDs not found; still proceed with the ones that are found.
  for (const id of chunkIds) {
    if (!allEntries.some((e) => e.chunk_id === id)) {
      log.warn("chunk_id not found in guide.yaml — skipping", { chunk_id: id });
    }
  }

  const toDelete = allEntries.filter((e) => idSet.has(e.chunk_id));

  if (toDelete.length === 0) {
    log.info("None of the specified chunk IDs found — no-op");
    return {
      success: true,
      action: "delete_chunks",
      removed: [],
      totalFinal: allEntries.length,
      reportPath: "",
    };
  }

  log.info("Chunks to delete", { count: toDelete.length });

  return deleteTail("delete_chunks", toDelete, allEntries, log);
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args[0] === "--chunk") {
    // Chunk-level delete: --chunk <id> [<id> ...]
    const ids = args.slice(1);
    if (ids.length === 0) {
      console.error(
        "Usage: bun generation/pipeline/delete.ts --chunk <chunk_id> [<chunk_id> ...]",
      );
      process.exit(1);
    }
    const result = await runDeleteChunks(ids);
    if (result.success) {
      console.log(`✅ Deleted ${result.removed.length} chunk(s)`);
      console.log(`   Total remaining: ${result.totalFinal}`);
      if (result.reportPath) console.log(`   Report: ${result.reportPath}`);
    } else {
      console.error(`❌ Delete failed: ${result.error}`);
      process.exit(1);
    }
  } else {
    // Source-level delete: <pdf_filename>
    const source = args[0];
    if (!source) {
      console.error("Usage: bun generation/pipeline/delete.ts <pdf_filename>");
      console.error(
        "       bun generation/pipeline/delete.ts --chunk <chunk_id> [<chunk_id> ...]",
      );
      process.exit(1);
    }

    const result = await runDelete(source);
    if (result.success) {
      console.log(
        `✅ Deleted ${result.removed.length} chunk(s) for "${source}"`,
      );
      console.log(`   Total remaining: ${result.totalFinal}`);
      if (result.reportPath) console.log(`   Report: ${result.reportPath}`);
    } else {
      console.error(`❌ Delete failed: ${result.error}`);
      process.exit(1);
    }
  }
}
