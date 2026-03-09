/**
 * generation/pipeline/guide-quality.ts
 *
 * Guide Quality Stage — §9 of the design spec.
 *
 * Reads guide.yaml and checks for structural issues that warrant human review.
 * Does NOT modify guide.yaml. No LLM calls.
 *
 * Checks:
 *   - duplicate_triggers      — same trigger text (case-insensitive) in 2+ chunks
 *   - orphan_related_chunks   — reference to chunk_id not present in guide.yaml
 *   - asymmetric_related_chunks — A→B exists but B doesn't reference A
 *   - missing_fields          — chunk missing chunk_id, topic, summary, or triggers
 *   - empty_triggers          — triggers list present but empty
 *
 * Writes: final/reports/guide_quality_<timestamp>.json
 * Fires notification stub after writing report.
 *
 * Run standalone: bun generation/pipeline/guide-quality.ts
 * Also called automatically at end of every compile and delete.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { CONFIG } from "../core/config.js";
import { makeLogger } from "../core/logger.js";
import { notify } from "../utils/notify.js";
import type { StageLogger } from "../core/logger.js";
import type { GuideEntry } from "./compile.js";

// ─── Report types (§16) ───────────────────────────────────────────────────────

interface DuplicateTriggerEntry {
  trigger: string;
  chunks: Array<{ chunk_id: string; topic: string; source: string }>;
}

interface ChunkRef {
  chunk_id: string;
  topic: string;
  source: string;
}

interface AsymmetricRef {
  chunk_id: string;
  topic: string;
  references: string; // "A→B"
}

interface MissingFieldEntry {
  chunk_id: string;
  topic: string;
  source: string;
  missing: string[];
}

export interface GuideQualityReport {
  timestamp: string;
  total_chunks: number;
  issues: {
    duplicate_triggers: DuplicateTriggerEntry[];
    orphan_related_chunks: ChunkRef[];
    asymmetric_related_chunks: AsymmetricRef[];
    missing_fields: MissingFieldEntry[];
    empty_triggers: ChunkRef[];
  };
  summary: {
    duplicate_trigger_groups: number;
    orphan_refs: number;
    asymmetric_refs: number;
    missing_field_chunks: number;
    empty_trigger_chunks: number;
  };
}

export interface GuideQualityResult {
  reportPath: string;
  report: GuideQualityReport;
}

// ─── Timestamp helper ─────────────────────────────────────────────────────────

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

// ─── Guide loader ─────────────────────────────────────────────────────────────

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

// ─── Checks ───────────────────────────────────────────────────────────────────

function checkDuplicateTriggers(
  entries: GuideEntry[],
): DuplicateTriggerEntry[] {
  // Map normalised trigger → list of chunks that claim it
  const triggerMap = new Map<
    string,
    Array<{ chunk_id: string; topic: string; source: string }>
  >();

  for (const e of entries) {
    for (const trigger of e.triggers) {
      const key = trigger.toLowerCase().trim();
      const existing = triggerMap.get(key) ?? [];
      existing.push({ chunk_id: e.chunk_id, topic: e.topic, source: e.source });
      triggerMap.set(key, existing);
    }
  }

  const duplicates: DuplicateTriggerEntry[] = [];
  for (const [trigger, chunks] of triggerMap.entries()) {
    if (chunks.length >= 2) {
      duplicates.push({ trigger, chunks });
    }
  }

  return duplicates;
}

function checkOrphanRefs(entries: GuideEntry[]): ChunkRef[] {
  const knownIds = new Set(entries.map((e) => e.chunk_id));
  const orphans: ChunkRef[] = [];

  for (const e of entries) {
    for (const ref of e.related_chunks) {
      if (!knownIds.has(ref)) {
        orphans.push({
          chunk_id: e.chunk_id,
          topic: e.topic,
          source: e.source,
        });
        break; // One entry per chunk (avoid duplicates if multiple orphan refs)
      }
    }
  }

  return orphans;
}

function checkAsymmetricRefs(entries: GuideEntry[]): AsymmetricRef[] {
  // Build a fast lookup map
  const relMap = new Map(
    entries.map((e) => [e.chunk_id, new Set(e.related_chunks)]),
  );
  const asymmetric: AsymmetricRef[] = [];

  for (const e of entries) {
    for (const ref of e.related_chunks) {
      const bRefs = relMap.get(ref);
      if (bRefs && !bRefs.has(e.chunk_id)) {
        asymmetric.push({
          chunk_id: e.chunk_id,
          topic: e.topic,
          references: `${e.chunk_id}→${ref}`,
        });
      }
    }
  }

  return asymmetric;
}

function checkMissingFields(entries: GuideEntry[]): MissingFieldEntry[] {
  const required = ["chunk_id", "topic", "summary", "triggers"] as const;
  const result: MissingFieldEntry[] = [];

  for (const e of entries) {
    const missing: string[] = [];
    for (const field of required) {
      const val = e[field];
      if (val === undefined || val === null || val === "") missing.push(field);
      else if (
        Array.isArray(val) &&
        (val as unknown[]).length === 0 &&
        field === "triggers"
      ) {
        // triggers being empty is handled by checkEmptyTriggers
      }
    }
    if (missing.length > 0) {
      result.push({
        chunk_id: e.chunk_id,
        topic: e.topic,
        source: e.source,
        missing,
      });
    }
  }

  return result;
}

function checkEmptyTriggers(entries: GuideEntry[]): ChunkRef[] {
  return entries
    .filter((e) => Array.isArray(e.triggers) && e.triggers.length === 0)
    .map((e) => ({ chunk_id: e.chunk_id, topic: e.topic, source: e.source }));
}

// ─── Stage ────────────────────────────────────────────────────────────────────

export async function runGuideQuality(
  existingLog?: StageLogger,
): Promise<GuideQualityResult> {
  const log = existingLog ?? makeLogger("guide_quality");
  const timestamp = makeTimestamp();

  log.info("Guide Quality check started", { timestamp });

  const guidePath = CONFIG.directories.guide;
  const reportsDir = CONFIG.directories.final_reports;

  // Load guide.yaml
  let entries: GuideEntry[] = [];
  try {
    const raw = await readFile(guidePath, "utf-8");
    entries = loadGuideEntries(raw);
    log.info("guide.yaml loaded", { total_chunks: entries.length });
  } catch {
    log.warn(
      "guide.yaml not found or unreadable — running checks on empty guide",
    );
  }

  // Run all checks
  const duplicateTriggers = checkDuplicateTriggers(entries);
  const orphanRelatedChunks = checkOrphanRefs(entries);
  const asymmetricRelatedChunks = checkAsymmetricRefs(entries);
  const missingFields = checkMissingFields(entries);
  const emptyTriggers = checkEmptyTriggers(entries);

  const report: GuideQualityReport = {
    timestamp,
    total_chunks: entries.length,
    issues: {
      duplicate_triggers: duplicateTriggers,
      orphan_related_chunks: orphanRelatedChunks,
      asymmetric_related_chunks: asymmetricRelatedChunks,
      missing_fields: missingFields,
      empty_triggers: emptyTriggers,
    },
    summary: {
      duplicate_trigger_groups: duplicateTriggers.length,
      orphan_refs: orphanRelatedChunks.length,
      asymmetric_refs: asymmetricRelatedChunks.length,
      missing_field_chunks: missingFields.length,
      empty_trigger_chunks: emptyTriggers.length,
    },
  };

  // Write report
  await mkdir(reportsDir, { recursive: true });
  const reportPath = join(reportsDir, `guide_quality_${timestamp}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf-8");

  log.info("Guide Quality report written", {
    reportPath,
    duplicate_trigger_groups: report.summary.duplicate_trigger_groups,
    orphan_refs: report.summary.orphan_refs,
    asymmetric_refs: report.summary.asymmetric_refs,
    missing_field_chunks: report.summary.missing_field_chunks,
    empty_trigger_chunks: report.summary.empty_trigger_chunks,
  });

  // Fire notification
  await notify(
    {
      event: "guide_quality_complete",
      payload: {
        timestamp,
        total_chunks: entries.length,
        summary: report.summary,
      },
    },
    log,
  );

  return { reportPath, report };
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

if (import.meta.main) {
  const result = await runGuideQuality();
  const s = result.report.summary;
  console.log(`\n📋 Guide Quality Report`);
  console.log(`   Total chunks:           ${result.report.total_chunks}`);
  console.log(
    `   Duplicate triggers:     ${s.duplicate_trigger_groups} group(s)`,
  );
  console.log(`   Orphan refs:            ${s.orphan_refs}`);
  console.log(`   Asymmetric refs:        ${s.asymmetric_refs}`);
  console.log(`   Missing fields:         ${s.missing_field_chunks} chunk(s)`);
  console.log(`   Empty triggers:         ${s.empty_trigger_chunks} chunk(s)`);
  console.log(`\n   Report: ${result.reportPath}\n`);

  const hasIssues = Object.values(s).some((v) => v > 0);
  process.exit(hasIssues ? 1 : 0);
}
