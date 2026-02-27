import type { GuideEntry } from "./schemas.js";

/**
 * Parse raw guide.yaml text into structured GuideEntry objects.
 * Used by extract.ts (to update guide) and llm-client.ts (to load chunks).
 */
export function parseGuideEntries(raw: string): GuideEntry[] {
  const entries: GuideEntry[] = [];
  const blocks = raw
    .split(/^  - chunk_id:/m)
    .filter((b) => b.trim() && !b.trim().startsWith("#"));

  for (const block of blocks) {
    try {
      const chunk_id = block.match(/^\s*([^\n]+)/)?.[1]?.trim() ?? "";
      const source =
        block.match(/\n\s+source:\s*(.+)/)?.[1]?.trim() ?? "unknown";
      const topic = block.match(/\n\s+topic:\s*(.+)/)?.[1]?.trim() ?? "";
      const summary =
        block.match(/summary:\s*>\s*\n\s+(.+)/)?.[1]?.trim() ?? "";
      const has_conditions =
        block.match(/\n\s+has_conditions:\s*(true|false)/)?.[1] === "true";
      const status = (block.match(/\n\s+status:\s*(\w+)/)?.[1]?.trim() ??
        "active") as "active" | "review" | "deprecated";

      const triggersSection = block.match(
        /\n\s+triggers:\s*\n((?:\s+- .+\n?)*)/,
      );
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

      if (chunk_id && topic) {
        entries.push({
          chunk_id,
          source,
          topic,
          summary,
          triggers,
          has_conditions,
          related_chunks,
          status,
        });
      }
    } catch {
      // skip malformed block
    }
  }
  return entries;
}

/**
 * Serialize GuideEntry[] to guide.yaml text.
 */
export function serializeGuideEntries(entries: GuideEntry[]): string {
  const lines: string[] = [
    "# Knowledge Base Guide Index",
    "# Auto-generated from chunk front matter — do not edit manually",
    "# Source of truth: individual chunk .md files in data/chunks/",
    "",
    "chunks:",
    "",
  ];

  for (const entry of entries) {
    lines.push(`  - chunk_id: ${entry.chunk_id}`);
    lines.push(`    source: ${entry.source}`);
    lines.push(`    topic: ${entry.topic}`);
    lines.push(`    summary: >`);
    lines.push(`      ${entry.summary}`);
    lines.push(`    triggers:`);
    for (const trigger of entry.triggers) {
      lines.push(`      - "${trigger.replace(/"/g, "'")}"`);
    }
    lines.push(`    has_conditions: ${entry.has_conditions}`);
    lines.push(`    related_chunks:`);
    for (const rel of entry.related_chunks) {
      lines.push(`      - ${rel}`);
    }
    lines.push(`    status: ${entry.status}`);
    lines.push("");
  }

  return lines.join("\n");
}
