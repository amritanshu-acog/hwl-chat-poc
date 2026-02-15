import { tool } from 'ai';
import { z } from 'zod';
import { ProcessRegistry } from './registry.js';

/**
 * Create tools for the LLM to interact with the process registry
 */
export function createTools(registry: ProcessRegistry) {
    return {
        /**
         * List all available troubleshooting processes
         */
        listAvailableProcesses: tool({
            description: 'Get a list of all available troubleshooting processes with their descriptions',
            parameters: z.object({}),
            execute: async () => {
                const processes = registry.listProcesses();
                return {
                    processes,
                    count: processes.length,
                };
            },
        }),

        /**
 * Get complete details of a specific process
 */
        getProcessDetails: tool({
            description: 'Retrieve the complete troubleshooting steps and details for a specific process',
            parameters: z.object({
                processName: z.string().describe('The exact name of the process to retrieve'),
            }),
            execute: async ({ processName }) => {
                const process = registry.getProcess(processName);

                console.log('🔍 DEBUG: Looking for:', processName);
                console.log('📦 DEBUG: Process found?', !!process);
                console.log('📦 DEBUG: Process data:', JSON.stringify(process, null, 2));

                if (!process) {
                    return {
                        error: `Process '${processName}' not found`,
                        availableProcesses: registry.listProcesses().map(p => p.name),
                    };
                }

                // Return the process clearly
                return {
                    success: true,
                    processName: process.processName,
                    description: process.description,
                    prerequisites: process.prerequisites,
                    steps: process.steps,
                    decisionPoints: process.decisionPoints,
                    expectedResolution: process.expectedResolution,
                };
            },
        }),

        /**
         * Search for processes by keywords
         */
        searchProcesses: tool({
            description: 'Find troubleshooting processes that match the given keywords',
            parameters: z.object({
                keywords: z.string().describe('Keywords to search for in process names and descriptions'),
            }),
            execute: async ({ keywords }) => {
                const results = registry.searchProcesses(keywords);
                return {
                    matches: results,
                    count: results.length,
                };
            },
        }),

        /**
         * Ask user for clarification
         */
        askClarification: tool({
            description: 'When the user query is ambiguous, ask them to clarify by choosing from predefined options',
            parameters: z.object({
                question: z.string().describe('The clarification question to ask the user'),
                options: z.array(z.string()).describe('Array of options for the user to choose from'),
            }),
            execute: async ({ question, options }) => {
                // This will be handled by the chat interface
                // Return the question and options for the chat loop to present
                return {
                    needsClarification: true,
                    question,
                    options,
                };
            },
        }),
    };
}

export type Tools = ReturnType<typeof createTools>;