/**
 * generation/pipeline/quality.ts
 *
 * Quality stage — §5 of the design spec.
 *
 * For each .md in output/chunk/<doc_type>/:
 *   1. Parse front matter + content
 *   2. Run all rules from rules/<doc_type>_rules.json
 *   3. Chunks with severity:error violations → fail/<doc_type>/<timestamp>/
 *   4. Passing chunks → pass/<doc_type>/
 *   5. Write JSON report to quality/reports/
 *   6. Fire notify hook
 *
 * A chunk FAILS only on severity:error violations. Warnings are recorded only.
 */

import { readdir, readFile, copyFile, mkdir, rm, writeFile } from "fs/promises";
import { join, basename } from "path";
import { CONFIG } from "../core/config.js";
import { makeLogger } from "../core/logger.js";
import { notify } from "../utils/notify.js";
import type { StageLogger } from "../core/logger.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RuleParam {
  [key: string]: unknown;
}

export interface Rule {
  id: string;
  description: string;
  field: string;
  check: string;
  severity: "error" | "warning";
  params: RuleParam;
}

export interface RuleViolation {
  rule_id: string;
  field: string;
  severity: "error" | "warning";
  message: string;
}

export interface ChunkReport {
  chunk_id: string;
  source: string;
  topic: string;
  passed: boolean;
  issues: RuleViolation[];
}

export interface QualityReport {
  doc_type: "procedure" | "qna";
  timestamp: string;
  total_chunks: number;
  passed: number;
  failed: number;
  chunks: ChunkReport[];
}

export interface QualityResult {
  doc_type: "procedure" | "qna";
  passed: number;
  failed: number;
  reportPath: string;
}

// ─── Front matter parser ──────────────────────────────────────────────────────

interface ParsedMd {
  frontMatter: Record<string, unknown>;
  content: string;
  raw: string;
}

function parseMdFile(raw: string): ParsedMd {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) {
    return { frontMatter: {}, content: raw, raw };
  }

  const fmRaw = fmMatch[1]!;
  const content = (fmMatch[2] ?? "").trim();
  const frontMatter: Record<string, unknown> = {};

  // Parse YAML front matter manually (avoid heavy yaml dep)
  let i = 0;
  const lines = fmRaw.split("\n");

  while (i < lines.length) {
    const line = lines[i]!;
    i++;

    // Skip blank lines
    if (!line.trim()) continue;

    // List field
    const listMatch = line.match(/^(\w+):\s*$/);
    if (listMatch) {
      const key = listMatch[1]!;
      const items: string[] = [];
      while (i < lines.length) {
        const nextLine = lines[i]!;
        if (!nextLine.startsWith("  -") && !nextLine.startsWith("- ")) break;
        const item = nextLine
          .replace(/^\s*-\s*/, "")
          .replace(/^"(.*)"$/, "$1")
          .trim();
        items.push(item);
        i++;
      }
      frontMatter[key] = items;
      continue;
    }

    // Scalar field
    const scalarMatch = line.match(/^(\w+):\s*(.*)/);
    if (scalarMatch) {
      const key = scalarMatch[1]!;
      let val: string = (scalarMatch[2] ?? "").trim();

      // Multiline scalar (>)
      if (val === ">") {
        const parts: string[] = [];
        while (i < lines.length) {
          const nextLine = lines[i]!;
          if (!nextLine.startsWith("  ")) break;
          parts.push(nextLine.trim());
          i++;
        }
        val = parts.join(" ");
      }

      // Strip quotes
      val = val.replace(/^"(.*)"$/, "$1");

      // Coerce booleans
      if (val === "true") {
        frontMatter[key] = true;
        continue;
      }
      if (val === "false") {
        frontMatter[key] = false;
        continue;
      }

      // Inline list []
      if (val === "[]") {
        frontMatter[key] = [];
        continue;
      }

      frontMatter[key] = val;
    }
  }

  return { frontMatter, content, raw };
}

/** Resolve a field path like "front_matter.topic" or "content" */
function resolveField(parsed: ParsedMd, fieldPath: string): unknown {
  if (fieldPath === "content") return parsed.content;
  if (fieldPath.startsWith("front_matter.")) {
    const key = fieldPath.slice("front_matter.".length);
    return parsed.frontMatter[key];
  }
  return undefined;
}

// ─── Check implementations ────────────────────────────────────────────────────

function runCheck(rule: Rule, parsed: ParsedMd): string | null {
  const value = resolveField(parsed, rule.field);
  const p = rule.params;

  switch (rule.check) {
    case "required_non_empty": {
      if (value === undefined || value === null || value === "") {
        return `Field is missing or empty`;
      }
      return null;
    }

    case "is_boolean": {
      if (typeof value !== "boolean") {
        return `Field must be boolean (true/false), got: ${JSON.stringify(value)}`;
      }
      return null;
    }

    case "is_list": {
      if (!Array.isArray(value)) {
        return `Field must be a list, got: ${typeof value}`;
      }
      return null;
    }

    case "is_list_non_empty": {
      if (!Array.isArray(value) || value.length === 0) {
        return `Field must be a non-empty list`;
      }
      return null;
    }

    case "min_list_count": {
      const min = (p["min"] as number) ?? 1;
      if (!Array.isArray(value) || value.length < min) {
        return `List must have at least ${min} items, got ${Array.isArray(value) ? value.length : 0}`;
      }
      return null;
    }

    case "valid_values": {
      const allowed = (p["values"] as string[]) ?? [];
      if (!allowed.includes(String(value))) {
        return `Value "${value}" is not one of: ${allowed.join(", ")}`;
      }
      return null;
    }

    case "single_sentence": {
      if (typeof value !== "string") return `Field must be a string`;
      if (value.includes("\n\n")) {
        return `Field must be a single sentence (no double newlines)`;
      }
      return null;
    }

    case "section_present": {
      const heading = (p["heading"] as string) ?? "";
      if (typeof value !== "string") return `Content must be a string`;
      if (!value.includes(heading)) {
        return `Required section "${heading}" not found in content`;
      }
      return null;
    }

    case "section_non_empty": {
      const heading = (p["heading"] as string) ?? "";
      if (typeof value !== "string") return `Content must be a string`;
      const idx = value.indexOf(heading);
      if (idx === -1) {
        return `Required section "${heading}" not found in content`;
      }
      const afterHeading = value.slice(idx + heading.length).trim();

      // NEW — section is non-empty if it has ANY content including sub-headings
      if (!afterHeading) {
        return `Section "${heading}" exists but has no content`;
      }
      return null;
    }

    case "content_matches_pattern": {
      const pattern = (p["pattern"] as string) ?? "";
      if (typeof value !== "string") return `Content must be a string`;
      try {
        if (!new RegExp(pattern).test(value)) {
          return `Content does not match required pattern: ${pattern}`;
        }
      } catch {
        return `Invalid regex pattern: ${pattern}`;
      }
      return null;
    }

    case "conditional_section": {
      const ifField = (p["if_field"] as string) ?? "";
      const ifValue = p["if_value"];
      const thenHeading = (p["then_heading"] as string) ?? "";

      const condValue = resolveField(parsed, `front_matter.${ifField}`);
      if (condValue !== ifValue) return null; // Condition not met — skip

      if (
        typeof parsed.content !== "string" ||
        !parsed.content.includes(thenHeading)
      ) {
        return `When ${ifField}=${JSON.stringify(ifValue)}, section "${thenHeading}" is required`;
      }
      return null;
    }

    case "conditional_pattern": {
      const ifField = (p["if_field"] as string) ?? "";
      const ifValue = p["if_value"];
      const pattern = (p["pattern"] as string) ?? "";

      const condValue = resolveField(parsed, `front_matter.${ifField}`);
      if (condValue !== ifValue) return null; // Condition not met — skip

      try {
        if (!new RegExp(pattern).test(parsed.content)) {
          return `When ${ifField}=${JSON.stringify(ifValue)}, content must match: ${pattern}`;
        }
      } catch {
        return `Invalid regex pattern: ${pattern}`;
      }
      return null;
    }

    default:
      return `Unknown check type: ${rule.check}`;
  }
}

// ─── Rules loader ─────────────────────────────────────────────────────────────

async function loadRules(rulesPath: string): Promise<Rule[]> {
  let raw: string;
  try {
    raw = await readFile(rulesPath, "utf-8");
  } catch {
    throw new Error(
      `Rules file not found at ${rulesPath}. Run generate_rules first.`,
    );
  }

  const parsed = JSON.parse(raw) as { rules?: Rule[] };
  if (!parsed.rules || !Array.isArray(parsed.rules)) {
    throw new Error(`Rules file at ${rulesPath} has no "rules" array.`);
  }
  return parsed.rules;
}

// ─── Stale pass cleanup ───────────────────────────────────────────────────────

/**
 * §5.1 Remove stale entries in pass/<doc_type>/ for sources being processed.
 * Matches by "source" field in front matter.
 */
async function removeStalePassEntries(
  passDir: string,
  incomingSources: Set<string>,
  log: StageLogger,
): Promise<void> {
  let files: string[];
  try {
    files = await readdir(passDir);
  } catch {
    return; // Dir doesn't exist yet — nothing to clean
  }

  for (const filename of files) {
    if (!filename.endsWith(".md")) continue;
    const filePath = join(passDir, filename);
    try {
      const raw = await readFile(filePath, "utf-8");
      const { frontMatter } = parseMdFile(raw);
      const source = frontMatter["source"] as string | undefined;
      if (source && incomingSources.has(source)) {
        await rm(filePath);
        log.info("Removed stale pass entry", { filename, source });
      }
    } catch {
      // Can't parse — leave it
    }
  }
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

// ─── Stage ────────────────────────────────────────────────────────────────────

export async function runQuality(
  doc_type: "procedure" | "qna",
): Promise<QualityResult> {
  const log = makeLogger("quality");
  const timestamp = makeTimestamp();

  log.info("Quality stage started", { doc_type, timestamp });

  // Load rules
  const rulesPath =
    doc_type === "procedure"
      ? CONFIG.quality.rules_procedure
      : CONFIG.quality.rules_qna;

  let rules: Rule[];
  try {
    rules = await loadRules(rulesPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("Cannot load rules — aborting quality stage", { error: msg });
    throw err;
  }

  log.info("Rules loaded", { count: rules.length, rulesPath });

  // Directories
  const chunkDir = join(CONFIG.directories.output_chunk, doc_type);
  const passDir = join(CONFIG.directories.output_quality_pass, doc_type);
  const failDir = join(
    CONFIG.directories.output_quality_fail,
    doc_type,
    timestamp,
  );
  const reportsDir = CONFIG.directories.output_quality_reports;

  // List incoming chunks
  let chunkFiles: string[];
  try {
    const all = await readdir(chunkDir);
    chunkFiles = all.filter((f) => f.endsWith(".md"));
  } catch {
    log.info("No chunk output directory found — nothing to validate", {
      chunkDir,
    });
    return { doc_type, passed: 0, failed: 0, reportPath: "" };
  }

  if (chunkFiles.length === 0) {
    log.info("No chunks to validate", { doc_type });
    return { doc_type, passed: 0, failed: 0, reportPath: "" };
  }

  log.info("Chunks to validate", { count: chunkFiles.length });

  // Determine incoming sources for stale cleanup
  const incomingSources = new Set<string>();
  for (const filename of chunkFiles) {
    try {
      const raw = await readFile(join(chunkDir, filename), "utf-8");
      const { frontMatter } = parseMdFile(raw);
      const source = frontMatter["source"] as string | undefined;
      if (source) incomingSources.add(source);
    } catch {
      /* skip */
    }
  }

  // Remove stale pass entries for incoming sources
  await removeStalePassEntries(passDir, incomingSources, log);

  // Ensure directories exist
  await mkdir(passDir, { recursive: true });
  await mkdir(reportsDir, { recursive: true });

  // Validate each chunk
  const chunkReports: ChunkReport[] = [];
  let passedCount = 0;
  let failedCount = 0;

  for (const filename of chunkFiles) {
    const filePath = join(chunkDir, filename);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch (err) {
      log.error("Cannot read chunk file — skipping", {
        filename,
        error: String(err),
      });
      continue;
    }

    const parsed = parseMdFile(raw);
    const chunk_id =
      (parsed.frontMatter["chunk_id"] as string) ?? filename.replace(".md", "");
    const source = (parsed.frontMatter["source"] as string) ?? "";
    const topic = (parsed.frontMatter["topic"] as string) ?? "";

    const issues: RuleViolation[] = [];

    for (const rule of rules) {
      const msg = runCheck(rule, parsed);
      if (msg) {
        issues.push({
          rule_id: rule.id,
          field: rule.field,
          severity: rule.severity,
          message: msg,
        });
      }
    }

    const hasErrors = issues.some((i) => i.severity === "error");
    const passed = !hasErrors;

    chunkReports.push({ chunk_id, source, topic, passed, issues });

    if (passed) {
      // Copy to pass/
      await copyFile(filePath, join(passDir, filename));
      passedCount++;
      log.info("Chunk passed", { filename, chunk_id, warnings: issues.length });
    } else {
      // Copy to fail/<timestamp>/
      await mkdir(failDir, { recursive: true });
      await copyFile(filePath, join(failDir, filename));
      failedCount++;
      const errors = issues.filter((i) => i.severity === "error");
      log.warn("Chunk failed", { filename, chunk_id, errors: errors.length });
      for (const issue of errors) {
        log.warn("  Rule violation", {
          rule_id: issue.rule_id,
          field: issue.field,
          message: issue.message,
        });
      }
    }
  }

  // Write quality report
  const report: QualityReport = {
    doc_type,
    timestamp,
    total_chunks: chunkFiles.length,
    passed: passedCount,
    failed: failedCount,
    chunks: chunkReports,
  };

  const reportFilename = `${doc_type}_${timestamp}.json`;
  const reportPath = join(reportsDir, reportFilename);
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf-8");

  log.info("Quality report written", { reportPath });
  log.info("Quality stage complete", {
    doc_type,
    total: chunkFiles.length,
    passed: passedCount,
    failed: failedCount,
  });

  // Fire notification
  await notify(
    {
      event: "quality_complete",
      payload: {
        doc_type,
        timestamp,
        total_chunks: chunkFiles.length,
        passed: passedCount,
        failed: failedCount,
      },
    },
    log,
  );

  return { doc_type, passed: passedCount, failed: failedCount, reportPath };
}

if (import.meta.main) {
  const doc_type = (process.argv[2] ?? "procedure") as "procedure" | "qna";
  const result = await runQuality(doc_type);
  console.log(
    `✅ Quality complete — passed=${result.passed} failed=${result.failed}`,
  );
  process.exit(result.failed > 0 ? 1 : 0);
}
