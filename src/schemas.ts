import { z } from "zod";

/**
 * Schema for a single node in a troubleshooting process graph
 */
export const ProcessNodeSchema = z.object({
  nodeId: z.string().min(1),
  type: z.enum(["question", "action", "decision", "info", "resolution"]),
  instruction: z.string().optional(),
  question: z.string().optional(),
  validationHint: z.string().optional(),
  message: z.string().optional(),
  next: z.record(z.string(), z.string()).optional(),
});

/**
 * Entry criteria for matching user queries to processes
 */
export const EntryCriteriaSchema = z.object({
  keywords: z.array(z.string()),
  requiredContext: z.array(z.string()).default([]),
});

/**
 * Complete troubleshooting process schema (node-based graph)
 */
export const TroubleshootingProcessSchema = z.object({
  processId: z.string().min(1),
  processName: z.string().min(1),
  description: z.string().min(1),
  tags: z.array(z.string()).default([]),
  version: z.string().default("1.0"),
  entryCriteria: EntryCriteriaSchema.optional(),
  nodes: z.array(ProcessNodeSchema).min(1),
});

// Export TypeScript types
export type ProcessNode = z.infer<typeof ProcessNodeSchema>;
export type EntryCriteria = z.infer<typeof EntryCriteriaSchema>;
export type TroubleshootingProcess = z.infer<
  typeof TroubleshootingProcessSchema
>;
