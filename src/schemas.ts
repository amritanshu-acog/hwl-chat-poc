import { z } from "zod";

// ─── Chunk Front Matter Schema ─────────────────────────────────────────────────
// Mirrors guide.yaml exactly — same fields, same schema, no duplication.
// One chunk = one concept/question.

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

// ─── Full Chunk Schema (front matter + markdown body sections) ─────────────────

export const ChunkSectionSchema = z.object({
  // Always present
  context: z.string().min(1),

  // Only present when has_conditions: true
  conditions: z.string().optional(),

  // Only present when hard system limits exist
  constraints: z.string().optional(),

  // Always present for active customer-facing chunks
  response: z.string().min(1),
});

export const ChunkSchema = z.object({
  front_matter: ChunkFrontMatterSchema,
  sections: ChunkSectionSchema,
});

// ─── LLM Extraction Output Schema ─────────────────────────────────────────────
// What we ask the LLM to return. Flat for easy JSON extraction, then we
// assemble the final .md and front matter from it.

export const LLMChunkOutputSchema = z.object({
  chunk_id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, "chunk_id must be lowercase-hyphenated"),
  topic: z.string().min(1),
  summary: z.string().min(1),
  triggers: z.array(z.string()).min(1),
  has_conditions: z.boolean(),
  related_chunks: z.array(z.string()).default([]),
  status: z.enum(["active", "review", "deprecated"]).default("active"),

  // Markdown body sections
  context: z.string().min(1),
  conditions: z.string().optional(), // required when has_conditions: true
  constraints: z.string().optional(),
  response: z.string().min(1),
});

export type LLMChunkOutput = z.infer<typeof LLMChunkOutputSchema>;
export type ChunkFrontMatter = z.infer<typeof ChunkFrontMatterSchema>;
export type ChunkSection = z.infer<typeof ChunkSectionSchema>;
export type Chunk = z.infer<typeof ChunkSchema>;

// ─── Guide YAML Entry ──────────────────────────────────────────────────────────
// Derived from chunk front matter after aggregation pass.

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

// ─── Chat Response Envelope ────────────────────────────────────────────────────
// What the LLM returns at runtime. Frontend reads `type` and renders
// the matching MDX component.

export const StepsResponseSchema = z.object({
  type: z.literal("steps"),
  data: z.object({
    title: z.string(),
    intro: z.string().optional(),
    steps: z.array(
      z.object({
        title: z.string(),
        body: z.string(),
      }),
    ),
    followUp: z.string().optional(),
  }),
});

export const ChoicesResponseSchema = z.object({
  type: z.literal("choices"),
  data: z.object({
    question: z.string(),
    options: z.array(
      z.object({
        label: z.string(),
        description: z.string().optional(),
      }),
    ),
  }),
});

export const AlertResponseSchema = z.object({
  type: z.literal("alert"),
  data: z.object({
    severity: z.enum(["info", "warning", "danger"]),
    title: z.string(),
    body: z.string(),
  }),
});

export const ImageBlockResponseSchema = z.object({
  type: z.literal("image"),
  data: z.object({
    caption: z.string(),
    description: z.string(),
    altText: z.string(),
  }),
});

export const ChecklistResponseSchema = z.object({
  type: z.literal("checklist"),
  data: z.object({
    title: z.string(),
    items: z.array(z.string()),
  }),
});

export const EscalationResponseSchema = z.object({
  type: z.literal("escalation"),
  data: z.object({
    reason: z.string(),
    summary: z.string(),
    ctaLabel: z.string().default("Create Support Ticket"),
  }),
});

export const SummaryResponseSchema = z.object({
  type: z.literal("summary"),
  data: z.object({
    title: z.string(),
    body: z.string(),
  }),
});

export const TextResponseSchema = z.object({
  type: z.literal("text"),
  data: z.object({
    body: z.string(),
  }),
});

export const ChatResponseSchema = z.discriminatedUnion("type", [
  StepsResponseSchema,
  ChoicesResponseSchema,
  AlertResponseSchema,
  ImageBlockResponseSchema,
  ChecklistResponseSchema,
  EscalationResponseSchema,
  SummaryResponseSchema,
  TextResponseSchema,
]);

export type ChatResponse = z.infer<typeof ChatResponseSchema>;
export type StepsResponse = z.infer<typeof StepsResponseSchema>;
export type ChoicesResponse = z.infer<typeof ChoicesResponseSchema>;
export type AlertResponse = z.infer<typeof AlertResponseSchema>;
export type ImageBlockResponse = z.infer<typeof ImageBlockResponseSchema>;
export type ChecklistResponse = z.infer<typeof ChecklistResponseSchema>;
export type EscalationResponse = z.infer<typeof EscalationResponseSchema>;
export type SummaryResponse = z.infer<typeof SummaryResponseSchema>;
export type TextResponse = z.infer<typeof TextResponseSchema>;
