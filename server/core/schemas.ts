import { z } from "zod";

// ─── Chunk & Guide Schemas ─────────────────────────────────────────────────────
// Shared between the generation pipeline (read-only here) and retrieval runtime.

export const ChunkFrontMatterSchema = z.object({
  chunk_id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, "chunk_id must be lowercase-hyphenated"),
  source: z.string().min(1),
  topic: z.string().min(1),
  summary: z.string().min(1),
  triggers: z.array(z.string()).default([]),
  has_conditions: z.boolean().default(false),
  related_chunks: z.array(z.string()).default([]),
  status: z.enum(["active", "review", "deprecated"]).default("active"),
});

export type ChunkFrontMatter = z.infer<typeof ChunkFrontMatterSchema>;

export const GuideEntrySchema = z.object({
  chunk_id: z.string(),
  source: z.string(),
  topic: z.string(),
  summary: z.string(),
  triggers: z.array(z.string()),
  has_conditions: z.boolean(),
  related_chunks: z.array(z.string()),
  status: z.enum(["active", "review", "deprecated"]),
});

export type GuideEntry = z.infer<typeof GuideEntrySchema>;

// ─── Triage Output ─────────────────────────────────────────────────────────────
// Exactly what the triage LLM returns — one of four actions.

export const TriageOutputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("clarify"),
    question: z.string(),
  }),
  z.object({
    action: z.literal("respond"),
    chunk_ids: z.array(z.string()),
    title: z.string(),
  }),
  z.object({
    action: z.literal("not_found"),
    title: z.string(),
  }),
  z.object({
    action: z.literal("new_topic"),
  }),
]);

export type TriageOutput = z.infer<typeof TriageOutputSchema>;
export type TriageAction = TriageOutput["action"];

// ─── Respond Output ────────────────────────────────────────────────────────────
// What the respond LLM returns — typed answer with cited chunk IDs.

export const RespondOutputSchema = z.object({
  type: z.enum(["answer", "options", "mixed", "notfound"]),
  response: z.string(),
  cited_chunk_ids: z.array(z.string()),
});

export type RespondOutput = z.infer<typeof RespondOutputSchema>;
export type ResponseType = RespondOutput["type"];

// ─── Citation ─────────────────────────────────────────────────────────────────
// Stored in session turn records and returned to the caller.

export const CitationSchema = z.object({
  chunk_id: z.string(),
  source: z.string(),
});

export type Citation = z.infer<typeof CitationSchema>;

// ─── Turn Result ───────────────────────────────────────────────────────────────
// The full response the pipeline returns — used by both the HTTP API and CLI.

export const TurnResultSchema = z.object({
  session_id: z.string(),

  // Triage action that produced this turn.
  action: z.enum(["clarify", "respond", "not_found", "quota_exceeded"]),

  // Formatted response text (from formatter, or fallback, or clarifying question).
  response: z.string(),

  // Finer-grained classification of what was returned.
  response_type: z.enum([
    "clarify", // clarifying question returned
    "answer", // direct single-path answer
    "options", // multiple conditional paths for user to choose
    "mixed", // narrative + conditional branches
    "notfound", // chunks retrieved or not — content did not answer
    "quota_exceeded", // session turn limit reached
  ]),

  // Non-empty only on respond → answer/options/mixed turns.
  citations: z.array(CitationSchema),
});

export type TurnResult = z.infer<typeof TurnResultSchema>;
