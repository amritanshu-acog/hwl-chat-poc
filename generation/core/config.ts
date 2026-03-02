/**
 * generation/s../core/config.ts
 *
 * Reads generation/config.toml at startup and exports a typed CONFIG object.
 * All pipeline code imports from here — no raw TOML parsing elsewhere.
 *
 * All path values in config.toml are relative to the project root (process.cwd()).
 */

import { readFileSync } from "fs";
import { join, resolve } from "path";
import { parse } from "smol-toml";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PipelineConfig {
  directories: {
    input_procedure: string;
    input_qna: string;
    processed: string;
    output_chunk: string;
    output_heading: string;
    output_quality_pass: string;
    output_quality_fail: string;
    output_quality_reports: string;
    final: string;
    final_backup: string;
    final_reports: string;
    log: string;
    guide: string;
  };
  prompts: {
    procedure: string;
    qna: string;
    heading: string;
    generate_rules: string;
    normalize_triggers: string;
  };
  models: {
    chunk: string;
    quality: string;
  };
  temperature: {
    chunk: number;
    quality: number;
  };
  chunks: {
    single_pass_threshold_kb: number;
    save_headings: boolean;
    section_delay_seconds: number;
    toc_max_pages: number;
    min_text_length_for_segmentation: number;
    min_segment_length: number;
  };
  quality: {
    rules_procedure: string;
    rules_qna: string;
  };
  related_chunks: {
    model: string;
    threshold: number;
    normalize_model: string;
  };
  logging: {
    level: string;
    log_dir: string;
  };
}

// ─── Loader ───────────────────────────────────────────────────────────────────

const PROJECT_ROOT = process.env.PROJECT_ROOT ?? process.cwd();
const CONFIG_PATH = join(PROJECT_ROOT, "generation", "config.toml");

function loadConfig(): PipelineConfig {
  let raw: string;
  try {
    raw = readFileSync(CONFIG_PATH, "utf-8");
  } catch (err) {
    throw new Error(
      `[config] Cannot read generation/config.toml at ${CONFIG_PATH}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (err) {
    throw new Error(
      `[config] Failed to parse generation/config.toml: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return parsed as PipelineConfig;
}

// ─── Resolve helpers ──────────────────────────────────────────────────────────
// Converts every path string in the config from project-root-relative to absolute.

function resolvePaths(cfg: PipelineConfig): PipelineConfig {
  const r = (p: string) => resolve(PROJECT_ROOT, p);

  return {
    ...cfg,
    directories: {
      input_procedure: r(cfg.directories.input_procedure),
      input_qna: r(cfg.directories.input_qna),
      processed: r(cfg.directories.processed),
      output_chunk: r(cfg.directories.output_chunk),
      output_heading: r(cfg.directories.output_heading),
      output_quality_pass: r(cfg.directories.output_quality_pass),
      output_quality_fail: r(cfg.directories.output_quality_fail),
      output_quality_reports: r(cfg.directories.output_quality_reports),
      final: r(cfg.directories.final),
      final_backup: r(cfg.directories.final_backup),
      final_reports: r(cfg.directories.final_reports),
      log: r(cfg.directories.log),
      guide: r(cfg.directories.guide),
    },
    prompts: {
      procedure: r(cfg.prompts.procedure),
      qna: r(cfg.prompts.qna),
      heading: r(cfg.prompts.heading),
      generate_rules: r(cfg.prompts.generate_rules),
      normalize_triggers: r(cfg.prompts.normalize_triggers),
    },
    quality: {
      rules_procedure: r(cfg.quality.rules_procedure),
      rules_qna: r(cfg.quality.rules_qna),
    },
    logging: {
      ...cfg.logging,
      log_dir: r(cfg.logging.log_dir),
    },
  };
}

// ─── Exported singleton ───────────────────────────────────────────────────────

export const CONFIG: PipelineConfig = resolvePaths(loadConfig());
