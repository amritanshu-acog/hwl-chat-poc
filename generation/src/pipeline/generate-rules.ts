/**
 * generation/src/pipeline/generate-rules.ts
 *
 * Generate Rules stage — §6 of the design spec.
 *
 * Reads the chunking prompts (procedure.md, qna.md), sends each to the LLM
 * with generate_rules.md as the system prompt, parses the JSON response,
 * and writes rules/procedure_rules.json and rules/qna_rules.json.
 *
 * Run once at setup; re-run whenever prompts change.
 * Usage: bun generation/src/pipeline/generate-rules.ts
 */

import { writeFile, mkdir } from "fs/promises";
import { dirname } from "path";
import { CONFIG } from "../core/config.js";
import { makeLogger } from "../core/logger.js";
import { callLlmJson, loadPromptFile } from "../core/llm.js";
import { withBackoff } from "../utils/backoff.js";

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

export interface RulesFile {
  rules: Rule[];
}

export interface GenerateRulesResult {
  procedure: {
    success: boolean;
    rulesCount: number;
    path: string;
    error?: string;
  };
  qna: { success: boolean; rulesCount: number; path: string; error?: string };
}

// ─── JSON cleaner ─────────────────────────────────────────────────────────────

function extractJson(raw: string): string {
  // Strip markdown fences if present
  let cleaned = raw
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();
  // Find first {
  const start = cleaned.indexOf("{");
  if (start === -1) return cleaned;
  cleaned = cleaned.slice(start);
  // Find matching closing }
  let depth = 0;
  let inString = false;
  let escape = false;
  let end = -1;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      end = i;
      break;
    }
  }
  return end !== -1 ? cleaned.slice(0, end + 1).trim() : cleaned;
}

// ─── Supported check types ────────────────────────────────────────────────────

const SUPPORTED_CHECKS = new Set([
  "required_non_empty",
  "is_boolean",
  "is_list",
  "is_list_non_empty",
  "min_list_count",
  "valid_values",
  "single_sentence",
  "section_present",
  "section_non_empty",
  "content_matches_pattern",
  "conditional_section",
  "conditional_pattern",
]);

function filterRules(rules: Rule[]): Rule[] {
  return rules.filter((r) => {
    if (!SUPPORTED_CHECKS.has(r.check)) return false;
    return true;
  });
}

// ─── Generate rules for one doc_type ─────────────────────────────────────────

async function generateRulesForDocType(
  doc_type: "procedure" | "qna",
  generateRulesPrompt: string,
  log: ReturnType<typeof makeLogger>,
): Promise<{ rulesCount: number; path: string }> {
  const chunkPromptPath =
    doc_type === "procedure" ? CONFIG.prompts.procedure : CONFIG.prompts.qna;
  const rulesPath =
    doc_type === "procedure"
      ? CONFIG.quality.rules_procedure
      : CONFIG.quality.rules_qna;

  log.info("Generating rules", { doc_type, chunkPromptPath });

  const chunkPrompt = loadPromptFile(chunkPromptPath);

  const userMessage = `Here is the chunking prompt for doc_type="${doc_type}". Extract validation rules from it.\n\n${chunkPrompt}`;

  const result = await withBackoff(
    () =>
      callLlmJson(
        {
          system: generateRulesPrompt,
          prompt: userMessage,
          model: CONFIG.models.quality,
          temperature: CONFIG.temperature.quality,
        },
        log,
      ),
    log,
  );

  // Parse JSON
  const cleaned = extractJson(result.text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(
      `Failed to parse rules JSON for ${doc_type}: ${err instanceof Error ? err.message : String(err)}\nRaw: ${cleaned.slice(0, 300)}`,
    );
  }

  const raw = parsed as { rules?: unknown };
  if (!raw.rules || !Array.isArray(raw.rules)) {
    throw new Error(`Rules JSON for ${doc_type} missing "rules" array`);
  }

  const allRules = raw.rules as Rule[];
  const filtered = filterRules(allRules);
  const dropped = allRules.length - filtered.length;

  if (dropped > 0) {
    log.warn("Dropped unsupported rule check types", { doc_type, dropped });
  }

  const rulesFile: RulesFile = { rules: filtered };

  // Ensure directory exists
  await mkdir(dirname(rulesPath), { recursive: true });
  await writeFile(rulesPath, JSON.stringify(rulesFile, null, 2), "utf-8");

  log.info("Rules written", {
    doc_type,
    rulesCount: filtered.length,
    path: rulesPath,
  });

  return { rulesCount: filtered.length, path: rulesPath };
}

// ─── Stage entry point ────────────────────────────────────────────────────────

export async function runGenerateRules(): Promise<GenerateRulesResult> {
  const log = makeLogger("generate_rules");
  log.info("Generate Rules stage started");

  const generateRulesPrompt = loadPromptFile(CONFIG.prompts.generate_rules);

  const result: GenerateRulesResult = {
    procedure: {
      success: false,
      rulesCount: 0,
      path: CONFIG.quality.rules_procedure,
    },
    qna: { success: false, rulesCount: 0, path: CONFIG.quality.rules_qna },
  };

  for (const doc_type of ["procedure", "qna"] as const) {
    try {
      const { rulesCount, path } = await generateRulesForDocType(
        doc_type,
        generateRulesPrompt,
        log,
      );
      result[doc_type] = { success: true, rulesCount, path };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.error("Failed to generate rules", { doc_type, error });
      result[doc_type] = {
        success: false,
        rulesCount: 0,
        path:
          doc_type === "procedure"
            ? CONFIG.quality.rules_procedure
            : CONFIG.quality.rules_qna,
        error,
      };
    }
  }

  log.info("Generate Rules stage complete", {
    procedure: result.procedure.success,
    qna: result.qna.success,
  });

  return result;
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

if (import.meta.main) {
  const result = await runGenerateRules();
  for (const [dt, r] of Object.entries(result)) {
    if (r.success) {
      console.log(`✅ ${dt}: ${r.rulesCount} rules → ${r.path}`);
    } else {
      console.error(`❌ ${dt}: ${r.error}`);
    }
  }
  process.exit(Object.values(result).every((r) => r.success) ? 0 : 1);
}
