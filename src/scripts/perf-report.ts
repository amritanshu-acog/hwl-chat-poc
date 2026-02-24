/**
 * src/scripts/perf-report.ts
 *
 * Performance profiling & summary (Task 17).
 * Reads structured reports from data/reports/ and summarizes metrics.
 */

import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { CONFIG } from "../config.js";

interface StepResult {
  step: string;
  success: boolean;
  durationMs: number;
}

interface IngestReport {
  startedAt: string;
  sources: string[];
  steps: StepResult[];
  totalDurationMs: number;
}

async function main() {
  const reportsDir = CONFIG.paths.reports;

  console.log("\n📊 HWL Ingestion Performance Report");
  console.log("═".repeat(40));

  let files: string[];
  try {
    files = (await readdir(reportsDir)).filter((f) => f.endsWith(".json"));
  } catch {
    console.error("❌ No reports found. Run bun run ingest first.");
    return;
  }

  if (files.length === 0) {
    console.warn("⚠️  No reports found in data/reports/");
    return;
  }

  const totals: Record<string, { totalMs: number; count: number }> = {};
  let weightedDuration = 0;
  let totalSources = 0;

  for (const file of files) {
    try {
      const raw = await readFile(join(reportsDir, file), "utf-8");
      const report = JSON.parse(raw) as IngestReport;

      weightedDuration += report.totalDurationMs;
      totalSources += report.sources.length;

      for (const step of report.steps) {
        if (!totals[step.step]) {
          totals[step.step] = { totalMs: 0, count: 0 };
        }
        const bucket = totals[step.step]!;
        bucket.totalMs += step.durationMs;
        bucket.count += 1;
      }
    } catch {
      /* skip corrupt json */
    }
  }

  console.log(`  Processed Runs:  ${files.length}`);
  console.log(`  Total Sources:   ${totalSources}`);
  console.log(
    `  Avg Run Time:    ${(weightedDuration / files.length / 1000).toFixed(1)}s\n`,
  );

  console.log("  Average Time per Step:");
  for (const [step, data] of Object.entries(totals)) {
    const avg = (data.totalMs / data.count / 1000).toFixed(1);
    const pad = " ".repeat(15 - step.length);
    console.log(`    • ${step}${pad} ${avg}s`);
  }
  console.log("");
}

main();
