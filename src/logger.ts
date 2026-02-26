/**
 * src/logger.ts
 *
 * Structured Log4j-style logger built on Winston.
 *
 * Design goals:
 *  - ELK-compatible JSON output on every log line (Logstash can ingest directly)
 *  - Log4j-style levels: error > warn > info > debug
 *  - Console transport shows pretty, colorized output during development
 *  - File transport writes newline-delimited JSON to logs/app.log (for Logstash)
 *  - Every log entry carries: timestamp, level, message, service, and any extra fields
 *
 * Usage:
 *   import { logger } from "./logger.js";
 *   logger.info("Extraction started", { source: "FAQ.pdf", segments: 42 });
 *   logger.warn("Segment short — merging", { segmentId: "foo-a1b2c3d4", chars: 80 });
 *   logger.error("LLM call failed", { error: err.message, chunkId });
 */

import winston from "winston";
import { join } from "path";

// ─── Constants ────────────────────────────────────────────────────────────────

const SERVICE_NAME = "hwl-ingestion-pipeline";
const LOG_DIR = join(process.cwd(), "logs");
const LOG_FILE = join(LOG_DIR, "app.log");
const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";

// ─── ELK-compatible JSON format ──────────────────────────────────────────────
//
// Produces one JSON object per line, e.g.:
//   {"timestamp":"2026-02-26T10:00:00.000Z","level":"info","service":"hwl-ingestion-pipeline","message":"...","source":"FAQ.pdf"}
//
// Logstash can consume this directly with a `json` codec input.

const elkJsonFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DDTHH:mm:ss.SSSZ" }),
  winston.format.errors({ stack: true }), // include stack traces in error logs
  winston.format((info) => {
    // Promote `service` field to top-level so ELK indexing is consistent
    info.service = SERVICE_NAME;
    return info;
  })(),
  winston.format.json(), // ensures a single-line JSON object
);

// ─── Pretty console format (developer experience) ────────────────────────────
//
// Shows coloured level + timestamp + message + metadata (compact JSON).
// This transport does NOT go to ELK — it's only for human eyes in the terminal.

const prettyConsoleFormat = winston.format.combine(
  winston.format.colorize({ all: true }),
  winston.format.timestamp({ format: "HH:mm:ss.SSS" }),
  winston.format.printf(
    ({ timestamp, level, message, service: _svc, ...meta }) => {
      // Stringify any extra metadata on the same line
      const extras = Object.keys(meta).length
        ? "  " + JSON.stringify(meta, null, 0)
        : "";
      return `[${timestamp}] ${level}: ${message}${extras}`;
    },
  ),
);

// ─── Logger instance ─────────────────────────────────────────────────────────

export const logger = winston.createLogger({
  level: LOG_LEVEL,
  defaultMeta: { service: SERVICE_NAME },
  transports: [
    // ── Console: pretty, coloured — for human use in dev/CI ─────────────────
    new winston.transports.Console({
      format: prettyConsoleFormat,
    }),

    // ── File: newline-delimited JSON — for Logstash → Elasticsearch → Kibana ─
    new winston.transports.File({
      filename: LOG_FILE,
      format: elkJsonFormat,
      // Keep up to 5 rolling log files of 10 MB each (simple log rotation)
      maxsize: 10 * 1024 * 1024, // 10 MB
      maxFiles: 5,
      tailable: true, // newest entries always at the bottom of app.log
    }),
  ],
});

// ─── Convenience re-exports ───────────────────────────────────────────────────
//
// These let callers bind a fixed `context` so repeated metadata fields
// (like the source PDF filename) don't have to be typed on every call.
//
// Example:
//   const log = childLogger({ source: "FAQ.pdf" });
//   log.info("Segment extracted", { segmentId, chars });

export function childLogger(meta: Record<string, unknown>) {
  return logger.child(meta);
}
