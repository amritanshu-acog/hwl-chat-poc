import { z } from 'zod';

/**
 * Schema for a single step in a troubleshooting process
 */
export const ProcessStepSchema = z.object({
    stepNumber: z.number().int().positive(),
    instruction: z.string().min(1),
    condition: z.string().nullable(),
    possibleOutcomes: z.array(z.string()),
});

/**
 * Schema for a decision point in the process
 */
export const DecisionPointSchema = z.object({
    question: z.string().min(1),
    options: z.array(
        z.object({
            answer: z.string(),
            nextStep: z.number().int().positive(),
        })
    ),
});

/**
 * Complete troubleshooting process schema
 */
export const TroubleshootingProcessSchema = z.object({
    processName: z.string().min(1),
    description: z.string().min(1),
    prerequisites: z.array(z.string()),
    steps: z.array(ProcessStepSchema),
    decisionPoints: z.array(DecisionPointSchema),
    expectedResolution: z.string().min(1),
});

// Export TypeScript types
export type ProcessStep = z.infer<typeof ProcessStepSchema>;
export type DecisionPoint = z.infer<typeof DecisionPointSchema>;
export type TroubleshootingProcess = z.infer<typeof TroubleshootingProcessSchema>;