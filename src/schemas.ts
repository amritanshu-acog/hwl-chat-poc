import { z } from "zod";

export const ProcessNodeSchema = z.object({
  nodeId: z.string().min(1),
  type: z.enum(["diagnostic", "solution", "resolution"]),
  // diagnostic: a question to identify the cause
  question: z.string().optional(),
  // solution: all fix steps for this branch, delivered at once
  steps: z.array(z.string()).optional(),
  // resolution: terminal message
  message: z.string().optional(),
  next: z.record(z.string(), z.string()).optional(),
});

export const EntryCriteriaSchema = z.object({
  keywords: z.array(z.string()),
  requiredContext: z.array(z.string()).default([]),
});

export const TroubleshootingProcessSchema = z.object({
  processId: z.string().min(1),
  processName: z.string().min(1),
  description: z.string().min(1),
  tags: z.array(z.string()).default([]),
  version: z.string().default("1.0"),
  entryCriteria: EntryCriteriaSchema.optional(),
  nodes: z.array(ProcessNodeSchema).min(1),
});

export type ProcessNode = z.infer<typeof ProcessNodeSchema>;
export type EntryCriteria = z.infer<typeof EntryCriteriaSchema>;
export type TroubleshootingProcess = z.infer<
  typeof TroubleshootingProcessSchema
>;
