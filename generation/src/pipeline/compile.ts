/**
 * generation/src/pipeline/compile.ts
 *
 * Compile stage — §7 of the design spec.
 *
 * 1. Collect all .md from pass/procedure/ and pass/qna/
 * 2. If pass/ is empty → no-op
 * 3. Backup final/ to final/backup/<timestamp>/ — abort if backup fails
 * 4. Use guide.yaml to find and delete stale chunks in final/ for incoming sources
 * 5. Copy incoming chunks from pass/ to final/
 * 6. Clear pass/ after successful promotion
 * 7. Rebuild guide.yaml from all .md in final/
 * 8. Compute related_chunks and write back to guide.yaml
 * 9. Write compile report to final/reports/<timestamp>.json
 */

import {
  readdir,
  readFile,
  writeFile,
  copyFile,
  rm,
  mkdir,
  cp,
} from "fs/promises";
import { join, basename } from "path";
import { CONFIG } from "../core/config.js";
import { makeLogger } from "../core/logger.js";
import { computeRelatedChunks } from "./related-chunks.js";
import type { StageLogger } from "../core/logger.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GuideEntry {
  chunk_id: string;
  source: string;
  topic: string;
  summary: string;
  triggers: string[];
  has_conditions: boolean;
  related_chunks: string[];
  status: string;
}

export interface CompileReport {
  timestamp: string;
  sources: string[];
  removed: Array<{ chunk_id: string; source: string; topic: string }>;
  added: Array<{ chunk_id: string; source: string; topic: string }>;
  total_final: number;
  related_chunks: unknown;
}

export interface CompileResult {
  success: boolean;
  reportPath: string;
  totalFinal: number;
  error?: string;
}

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

// ─── Front matter parser ──────────────────────────────────────────────────────

function parseFrontMatter(raw: string): Record<string, unknown> {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return {};

  const fmRaw = fmMatch[1]!;
  const result: Record<string, unknown> = {};
  const lines = fmRaw.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    i++;
    if (!line.trim()) continue;

    // List field
    const listMatch = line.match(/^(\w+):\s*$/);
    if (listMatch) {
      const key = listMatch[1]!;
      const items: string[] = [];
      while (i < lines.length) {
        const next = lines[i]!;
        if (!next.startsWith("  -") && !next.startsWith("- ")) break;
        items.push(
          next
            .replace(/^\s*-\s*/, "")
            .replace(/^"(.*)"$/, "$1")
            .trim(),
        );
        i++;
      }
      result[key] = items;
      continue;
    }

    // Scalar
    const scalarMatch = line.match(/^(\w+):\s*(.*)/);
    if (scalarMatch) {
      const key = scalarMatch[1]!;
      let val = (scalarMatch[2] ?? "").trim();

      if (val === ">") {
        const parts: string[] = [];
        while (i < lines.length && lines[i]!.startsWith("  ")) {
          parts.push(lines[i]!.trim());
          i++;
        }
        val = parts.join(" ");
      }

      val = val.replace(/^"(.*)"$/, "$1");
      if (val === "true") {
        result[key] = true;
        continue;
      }
      if (val === "false") {
        result[key] = false;
        continue;
      }
      if (val === "[]") {
        result[key] = [];
        continue;
      }
      result[key] = val;
    }
  }

  return result;
}

// ─── Guide.yaml builder ───────────────────────────────────────────────────────

/** Read all .md files in final/ and build a guide.yaml from their front matter. */
async function buildGuideYaml(
  finalDir: string,
  log: StageLogger,
): Promise<GuideEntry[]> {
  const files = (await readdir(finalDir)).filter((f) => f.endsWith(".md"));
  const entries: GuideEntry[] = [];

  for (const filename of files) {
    try {
      const raw = await readFile(join(finalDir, filename), "utf-8");
      const fm = parseFrontMatter(raw);

      if (!fm["source"]) {
        log.warn("Chunk missing source field — skipping from guide", {
          filename,
        });
        continue;
      }

      entries.push({
        chunk_id: (fm["chunk_id"] as string) ?? filename.replace(".md", ""),
        source: fm["source"] as string,
        topic: (fm["topic"] as string) ?? "",
        summary: (fm["summary"] as string) ?? "",
        triggers: (fm["triggers"] as string[]) ?? [],
        has_conditions: (fm["has_conditions"] as boolean) ?? false,
        related_chunks: (fm["related_chunks"] as string[]) ?? [],
        status: (fm["status"] as string) ?? "active",
      });
    } catch (err) {
      log.warn("Cannot parse chunk — skipping from guide", {
        filename,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return entries;
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

// ─── Load current guide ───────────────────────────────────────────────────────

async function loadCurrentGuide(
  guidePath: string,
  log: StageLogger,
): Promise<GuideEntry[]> {
  let raw: string;
  try {
    raw = await readFile(guidePath, "utf-8");
  } catch {
    return []; // Guide doesn't exist yet
  }

  // Very lightweight YAML list parser
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
          // inline list
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
  } catch (err) {
    log.warn("guide.yaml malformed — treating as empty", {
      error: String(err),
    });
    return [];
  }
}

// ─── Backup ───────────────────────────────────────────────────────────────────

async function backupFinal(
  finalDir: string,
  backupDir: string,
  timestamp: string,
  log: StageLogger,
): Promise<string | null> {
  // Check if there's anything worth backing up
  let files: string[];
  try {
    files = await readdir(finalDir);
  } catch {
    return null;
  }

  const hasContent =
    files.some((f) => f.endsWith(".md")) || files.includes("guide.yaml");

  if (!hasContent) {
    log.info("Final directory has no content — skipping backup");
    return null;
  }

  const dest = join(backupDir, timestamp);
  log.info("Backing up final/", { dest });

  try {
    await mkdir(dest, { recursive: true });
    const filesToBackup = (await readdir(finalDir)).filter(
      (f) => f.endsWith(".md") || f === "guide.yaml",
    );
    for (const f of filesToBackup) {
      await copyFile(join(finalDir, f), join(dest, f));
    }
    log.info("Backup complete", { dest });
    return dest;
  } catch (err) {
    throw new Error(
      `Backup failed — aborting compile. Final/ is intact. Error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ─── Stage ────────────────────────────────────────────────────────────────────

export async function runCompile(): Promise<CompileResult> {
  const log = makeLogger("compile");
  const timestamp = makeTimestamp();

  log.info("Compile stage started", { timestamp });

  const finalDir = CONFIG.directories.final;
  const backupDir = CONFIG.directories.final_backup;
  const reportsDir = CONFIG.directories.final_reports;
  const guidePath = CONFIG.directories.guide;

  const passDirs = [
    join(CONFIG.directories.output_quality_pass, "procedure"),
    join(CONFIG.directories.output_quality_pass, "qna"),
  ];

  // ── Collect all .md from pass/ ────────────────────────────────────────────
  const passFiles: Array<{ filePath: string; filename: string }> = [];
  for (const passDir of passDirs) {
    try {
      const files = (await readdir(passDir)).filter((f) => f.endsWith(".md"));
      for (const f of files) {
        passFiles.push({ filePath: join(passDir, f), filename: f });
      }
    } catch {
      // Directory may not exist — fine
    }
  }

  if (passFiles.length === 0) {
    log.info("Pass/ is empty — no-op");
    return { success: true, reportPath: "", totalFinal: 0 };
  }

  log.info("Pass chunks to promote", { count: passFiles.length });

  // ── Backup final/ ─────────────────────────────────────────────────────────
  let backupPath: string | null = null;
  try {
    backupPath = await backupFinal(finalDir, backupDir, timestamp, log);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error("Backup failed — aborting compile", { error });
    return { success: false, reportPath: "", totalFinal: 0, error };
  }

  // From here, errors attempt restore from backup
  try {
    // ── Determine incoming sources ──────────────────────────────────────────
    const incomingSources = new Set<string>();
    const incomingMeta: Array<{
      chunk_id: string;
      source: string;
      topic: string;
    }> = [];

    for (const { filePath } of passFiles) {
      try {
        const raw = await readFile(filePath, "utf-8");
        const fm = parseFrontMatter(raw);
        const source = fm["source"] as string | undefined;
        if (source) incomingSources.add(source);
        incomingMeta.push({
          chunk_id: (fm["chunk_id"] as string) ?? "",
          source: source ?? "",
          topic: (fm["topic"] as string) ?? "",
        });
      } catch {
        /* skip */
      }
    }

    // ── Load current guide and find stale chunks ────────────────────────────
    const currentGuide = await loadCurrentGuide(guidePath, log);
    const staleChunks = currentGuide.filter((e) =>
      incomingSources.has(e.source),
    );
    const removed: Array<{ chunk_id: string; source: string; topic: string }> =
      [];

    await mkdir(finalDir, { recursive: true });

    for (const stale of staleChunks) {
      const staleFile = join(finalDir, `${stale.chunk_id}.md`);
      try {
        await rm(staleFile);
        removed.push({
          chunk_id: stale.chunk_id,
          source: stale.source,
          topic: stale.topic,
        });
        log.info("Removed stale chunk", {
          chunk_id: stale.chunk_id,
          source: stale.source,
        });
      } catch {
        // File may already be gone — not critical
      }
    }

    // ── Promote pass/ → final/ ──────────────────────────────────────────────
    for (const { filePath, filename } of passFiles) {
      await copyFile(filePath, join(finalDir, filename));
    }

    log.info("Chunks promoted to final/", { count: passFiles.length });

    // ── Clear pass/ ───────────────────────────────────────────────────────
    for (const passDir of passDirs) {
      try {
        const files = (await readdir(passDir)).filter((f) => f.endsWith(".md"));
        for (const f of files) {
          await rm(join(passDir, f));
        }
      } catch {
        /* ok */
      }
    }

    log.info("Pass/ directories cleared");

    // ── Rebuild guide.yaml ────────────────────────────────────────────────
    const allEntries = await buildGuideYaml(finalDir, log);
    log.info("Guide rebuilt", { totalChunks: allEntries.length });

    // ── Compute related_chunks ────────────────────────────────────────────
    let relatedResult: unknown = { error: "not computed" };
    try {
      relatedResult = await computeRelatedChunks(allEntries, log);
      // Write back updated related_chunks to guide entries
      const relatedMap = (relatedResult as any).relatedMap as
        | Map<string, string[]>
        | undefined;
      if (relatedMap) {
        for (const entry of allEntries) {
          entry.related_chunks = relatedMap.get(entry.chunk_id) ?? [];
        }
      }
    } catch (err) {
      log.warn("Related chunks computation failed — non-fatal", {
        error: err instanceof Error ? err.message : String(err),
      });
      relatedResult = {
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // Write guide.yaml
    await writeFile(guidePath, serializeGuideYaml(allEntries), "utf-8");
    log.info("guide.yaml written", { guidePath, entries: allEntries.length });

    // ── Write compile report ──────────────────────────────────────────────
    await mkdir(reportsDir, { recursive: true });

    const report: CompileReport = {
      timestamp,
      sources: [...incomingSources],
      removed,
      added: incomingMeta,
      total_final: allEntries.length,
      related_chunks: relatedResult,
    };

    const reportPath = join(reportsDir, `${timestamp}.json`);
    await writeFile(reportPath, JSON.stringify(report, null, 2), "utf-8");

    log.info("Compile stage complete", {
      removed: removed.length,
      added: passFiles.length,
      total_final: allEntries.length,
      reportPath,
    });

    return { success: true, reportPath, totalFinal: allEntries.length };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error("Compile failed — attempting restore from backup", { error });

    if (backupPath) {
      try {
        await rm(finalDir, { recursive: true, force: true });
        await cp(backupPath, finalDir, { recursive: true });
        log.info("Restore from backup succeeded", { backupPath });
      } catch (restoreErr) {
        log.error("RESTORE FAILED — manual intervention required", {
          backupPath,
          error: String(restoreErr),
        });
      }
    }

    return { success: false, reportPath: "", totalFinal: 0, error };
  }
}

if (import.meta.main) {
  const result = await runCompile();
  if (result.success) {
    console.log(`✅ Compile complete — total_final=${result.totalFinal}`);
  } else {
    console.error(`❌ Compile failed — ${result.error}`);
    process.exit(1);
  }
}
