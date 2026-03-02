/**
 * generation/src/core/logger.ts
 *
 * Per-stage logger factory.
 *
 * Usage:
 *   const log = makeLogger("chunk");
 *   log.info("PDF processing started", { source: "Manual.pdf" });
 *
 * Format: timestamp | LEVEL   | stage_name | message  {"key":"value"}
 *
 * Each stage gets its own timestamped log file under output/log/:
 *   generation/output/log/chunk_20260302_115932.log
 *   generation/output/log/quality_20260302_115932.log
 *   etc.
 */

import winston from "winston";
import { mkdirSync } from "fs";
import { join } from "path";
import { CONFIG } from "./config.js";

// ─── Shared log dir ───────────────────────────────────────────────────────────

mkdirSync(CONFIG.logging.log_dir, { recursive: true });

// ─── Run timestamp ────────────────────────────────────────────────────────────
// Stable for the entire process lifetime — all stages in one run share
// the same timestamp suffix so log files sort together.

const RUN_TIMESTAMP = (() => {
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
})();

// ─── Format ───────────────────────────────────────────────────────────────────
// Design spec: "timestamp | level | logger_name | message"

function makeFormat(stageName: string) {
  return winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const metaStr =
        Object.keys(meta).length > 0
          ? "  " + JSON.stringify(meta, null, 0)
          : "";
      const levelPadded = level.toUpperCase().padEnd(7);
      return `${timestamp} | ${levelPadded} | ${stageName} | ${message}${metaStr}`;
    }),
  );
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a named logger for a pipeline stage.
 *
 * @param stage  Stage name: "chunk" | "quality" | "compile" | "archive" | "delete" | "generate_rules"
 * @returns      Winston logger instance writing to stdout and a stage-specific log file.
 */
export function makeLogger(stage: string): winston.Logger {
  const logFile = join(CONFIG.logging.log_dir, `${stage}_${RUN_TIMESTAMP}.log`);

  return winston.createLogger({
    level: CONFIG.logging.level.toLowerCase(),
    format: makeFormat(stage),
    transports: [
      new winston.transports.Console(),
      new winston.transports.File({ filename: logFile }),
    ],
  });
}

export type StageLogger = ReturnType<typeof makeLogger>;
