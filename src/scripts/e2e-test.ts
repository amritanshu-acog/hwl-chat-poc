/**
 * src/scripts/e2e-test.ts  — GAP-D1-11
 *
 * Minimal end-to-end ingestion test.
 *
 * Verifies that the extract → validate → rebuild pipeline produces
 * well-formed output without requiring the LLM to be called
 * (tests structural invariants only).
 *
 * Usage:
 *   bun run e2e-test
 *
 * Exit codes:
 *   0 — all invariants pass
 *   1 — one or more checks failed
 */

import { readdir, readFile, stat } from "fs/promises";
import { join } from "path";
import { GuideEntrySchema, ChunkFrontMatterSchema } from "../schemas.js";
import { ZodError } from "zod";

const CHUNKS_DIR = join(process.cwd(), "data", "chunks");
const GUIDE_PATH = join(process.cwd(), "data", "guide.yaml");

// ─── Assertion helpers ────────────────────────────────────────────────────────

let totalChecks = 0;
let passedChecks = 0;
let failedChecks = 0;
const failures: string[] = [];

function check(name: string, passed: boolean, detail?: string): void {
  totalChecks++;
  if (passed) {
    passedChecks++;
    console.log(`  ✅ ${name}`);
  } else {
    failedChecks++;
    const msg = detail ? `${name} — ${detail}` : name;
    failures.push(msg);
    console.log(`  ❌ ${name}${detail ? `: ${detail}` : ""}`);
  }
}

// ─── Guide.yaml parser ────────────────────────────────────────────────────────

function parseGuideBlocks(
  raw: string,
): Array<{ chunk_id: string; file: string; status: string }> {
  const blocks = raw
    .split(/^  - chunk_id:/m)
    .filter((b) => b.trim() && !b.trim().startsWith("#"));
  return blocks
    .map((block) => ({
      chunk_id: block.match(/^\s*([^\n]+)/)?.[1]?.trim() ?? "",
      file: block.match(/\n\s+file:\s*(.+)/)?.[1]?.trim() ?? "",
      status: block.match(/\n\s+status:\s*(\w+)/)?.[1]?.trim() ?? "active",
    }))
    .filter((e) => e.chunk_id);
}

// ─── Chunk front-matter parser (same as validate-guide.ts) ────────────────────

function parseChunkFrontMatter(raw: string): Record<string, unknown> | null {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const fm = fmMatch[1]!;

  const chunk_id = fm.match(/^chunk_id:\s*(.+)$/m)?.[1]?.trim() ?? "";
  const topic = fm.match(/^topic:\s*(.+)$/m)?.[1]?.trim() ?? "";
  const summary = fm.match(/^summary:\s*>\s*\n\s+(.+)$/m)?.[1]?.trim() ?? "";
  const has_conditions =
    fm.match(/^has_conditions:\s*(true|false)$/m)?.[1] === "true";
  const escalationRaw =
    fm.match(/^escalation:\s*(.+)$/m)?.[1]?.trim() ?? "null";
  const escalation =
    escalationRaw === "null" ? null : escalationRaw.replace(/^"|"$/g, "");
  const rawStatus = fm.match(/^status:\s*(\w+)$/m)?.[1]?.trim() ?? "active";

  const triggersSection = fm.match(/^triggers:\s*\n((?:\s+- .+\n?)*)/m);
  const triggers = triggersSection?.[1]
    ? [...triggersSection[1].matchAll(/- "?(.+?)"?\s*$/gm)].map((m) =>
        m[1]!.trim(),
      )
    : [];

  const relatedSection = fm.match(/^related_chunks:\s*\n((?:\s+- .+\n?)*)/m);
  const related_chunks = relatedSection?.[1]
    ? [...relatedSection[1].matchAll(/- (.+?)\s*$/gm)].map((m) =>
        m[1]!.trim().replace(/^chunk_id:/i, ""),
      )
    : [];

  return {
    chunk_id,
    topic,
    summary,
    triggers,
    has_conditions,
    escalation,
    related_chunks,
    status: rawStatus,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

async function testFileSystemIntegrity(): Promise<void> {
  console.log("\n📁 Test: File System Integrity");

  // guide.yaml exists
  try {
    await stat(GUIDE_PATH);
    check("guide.yaml exists", true);
  } catch {
    check("guide.yaml exists", false, "Run bun run extract first");
    return;
  }

  // chunks directory exists
  try {
    await stat(CHUNKS_DIR);
    check("data/chunks/ directory exists", true);
  } catch {
    check("data/chunks/ directory exists", false, "Run bun run extract first");
  }
}

async function testGuideYamlVsFilesystem(): Promise<{
  guideEntries: Array<{ chunk_id: string; file: string; status: string }>;
  mdFiles: string[];
}> {
  console.log("\n📋 Test: guide.yaml ↔ Filesystem Consistency");

  const guideRaw = await readFile(GUIDE_PATH, "utf-8").catch(() => "");
  const guideEntries = parseGuideBlocks(guideRaw);
  const mdFiles = (await readdir(CHUNKS_DIR).catch(() => [])).filter((f) =>
    f.endsWith(".md"),
  );

  check(
    "guide.yaml has at least 1 entry",
    guideEntries.length > 0,
    guideEntries.length === 0 ? "Empty guide" : undefined,
  );
  check(
    "data/chunks/ has at least 1 .md file",
    mdFiles.length > 0,
    mdFiles.length === 0 ? "No chunk files found" : undefined,
  );

  // Every guide entry has a corresponding .md file
  for (const entry of guideEntries) {
    if (!entry.file) continue;
    const fileName = entry.file.split("/").pop() ?? "";
    check(
      `guide entry '${entry.chunk_id}' has .md file`,
      mdFiles.includes(fileName),
      mdFiles.includes(fileName) ? undefined : `Missing: ${entry.file}`,
    );
  }

  // Every .md file has a guide entry
  for (const file of mdFiles) {
    const entryExists = guideEntries.some((e) => e.file.endsWith(file));
    check(
      `${file} has guide.yaml entry`,
      entryExists,
      entryExists ? undefined : "No matching entry in guide.yaml",
    );
  }

  return { guideEntries, mdFiles };
}

async function testChunkSchemas(mdFiles: string[]): Promise<void> {
  console.log("\n🔍 Test: Chunk Front-Matter Schema Validation");

  for (const file of mdFiles.sort()) {
    const filePath = join(CHUNKS_DIR, file);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch {
      check(`${file} is readable`, false, "Could not read file");
      continue;
    }

    const fm = parseChunkFrontMatter(raw);
    if (!fm) {
      check(`${file} has valid front matter`, false, "No --- delimiters found");
      continue;
    }

    try {
      ChunkFrontMatterSchema.parse(fm);
      check(`${file} front-matter schema`, true);
    } catch (err) {
      if (err instanceof ZodError) {
        const first = err.issues[0];
        check(
          `${file} front-matter schema`,
          false,
          first ? `${first.path.join(".")}: ${first.message}` : "Schema error",
        );
      } else {
        check(`${file} front-matter schema`, false, String(err));
      }
    }
  }
}

async function testRequiredSections(mdFiles: string[]): Promise<void> {
  console.log("\n📄 Test: Required Markdown Sections");

  const required = ["## Context", "## Response", "## Escalation"];

  for (const file of mdFiles.sort()) {
    const raw = await readFile(join(CHUNKS_DIR, file), "utf-8").catch(() => "");
    for (const section of required) {
      check(
        `${file} has ${section}`,
        raw.includes(section),
        raw.includes(section) ? undefined : `Missing section: ${section}`,
      );
    }
  }
}

async function testGuideEntrySchemas(
  entries: Array<{ chunk_id: string; file: string; status: string }>,
): Promise<void> {
  console.log("\n📊 Test: guide.yaml Entry Schema Validation");

  const guideRaw = await readFile(GUIDE_PATH, "utf-8").catch(() => "");
  const blocks = guideRaw
    .split(/^  - chunk_id:/m)
    .filter((b) => b.trim() && !b.trim().startsWith("#"));

  for (const block of blocks) {
    const chunk_id = block.match(/^\s*([^\n]+)/)?.[1]?.trim() ?? "";
    if (!chunk_id) continue;

    const topic = block.match(/\n\s+topic:\s*(.+)/)?.[1]?.trim() ?? "";
    const summary = block.match(/summary:\s*>\s*\n\s+(.+)/)?.[1]?.trim() ?? "";
    const file = block.match(/\n\s+file:\s*(.+)/)?.[1]?.trim() ?? "";
    const has_conditions =
      block.match(/\n\s+has_conditions:\s*(true|false)/)?.[1] === "true";
    const escalationRaw =
      block.match(/\n\s+escalation:\s*(.+)/)?.[1]?.trim() ?? "null";
    const escalation =
      escalationRaw === "null" ? null : escalationRaw.replace(/^"|"$/g, "");
    const rawStatus =
      block.match(/\n\s+status:\s*(\w+)/)?.[1]?.trim() ?? "active";

    const triggersSection = block.match(/\n\s+triggers:\s*\n((?:\s+- .+\n?)*)/);
    const triggers = triggersSection?.[1]
      ? [...triggersSection[1].matchAll(/- "?(.+?)"?\s*$/gm)].map((m) =>
          m[1]!.trim(),
        )
      : [];

    const relatedSection = block.match(
      /\n\s+related_chunks:\s*\n((?:\s+- .+\n?)*)/,
    );
    const related_chunks = relatedSection?.[1]
      ? [...relatedSection[1].matchAll(/- (.+?)\s*$/gm)].map((m) =>
          m[1]!.trim().replace(/^chunk_id:/i, ""),
        )
      : [];

    try {
      GuideEntrySchema.parse({
        chunk_id,
        topic,
        summary,
        triggers,
        has_conditions,
        escalation,
        related_chunks,
        status: rawStatus,
        file,
      });
      check(`guide entry '${chunk_id}' schema`, true);
    } catch (err) {
      if (err instanceof ZodError) {
        const first = err.issues[0];
        check(
          `guide entry '${chunk_id}' schema`,
          false,
          first ? `${first.path.join(".")}: ${first.message}` : "Schema error",
        );
      } else {
        check(`guide entry '${chunk_id}' schema`, false, String(err));
      }
    }
  }
}

async function testNoChunkIdPrefixes(mdFiles: string[]): Promise<void> {
  console.log("\n🔗 Test: related_chunks Format Normalisation (GAP-D1-05)");

  for (const file of mdFiles) {
    const raw = await readFile(join(CHUNKS_DIR, file), "utf-8").catch(() => "");
    const hasBadPrefix = /- chunk_id:/i.test(raw);
    check(
      `${file} has no 'chunk_id:' prefix in related_chunks`,
      !hasBadPrefix,
      hasBadPrefix
        ? "Fix: strip 'chunk_id:' prefix, re-run bun run rebuild"
        : undefined,
    );
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n🧪 HWL Knowledge Base — End-to-End Structural Tests\n");
  console.log("═".repeat(55));

  await testFileSystemIntegrity();
  const { guideEntries, mdFiles } = await testGuideYamlVsFilesystem();

  if (mdFiles.length > 0) {
    await testChunkSchemas(mdFiles);
    await testRequiredSections(mdFiles);
    await testNoChunkIdPrefixes(mdFiles);
  }

  if (guideEntries.length > 0) {
    await testGuideEntrySchemas(guideEntries);
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log("\n" + "═".repeat(55));
  console.log(`\n📊 E2E Test Results`);
  console.log(`   Total:   ${totalChecks}`);
  console.log(`   Passed:  ${passedChecks}`);
  console.log(`   Failed:  ${failedChecks}`);

  if (failures.length > 0) {
    console.log(`\n❌ Failed checks:`);
    failures.forEach((f) => console.log(`   • ${f}`));
    console.log("");
    process.exit(1);
  } else {
    console.log(`\n✅ All structural invariants pass.\n`);
  }
}

main().catch((err) => {
  console.error("❌ E2E test runner failed:", err);
  process.exit(1);
});
