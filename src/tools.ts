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
            description: 'Get a list of all available troubleshooting processes with their descriptions and tags',
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
            description: 'Retrieve the complete troubleshooting nodes and details for a specific process. You can use either the processId (e.g. "smtp-connection-issue") or processName (e.g. "SMTP Connection Issue"). Always use the processId from searchProcesses results when available.',
            parameters: z.object({
                processId: z.string().describe('The processId or processName of the process to retrieve. Prefer using the processId returned by searchProcesses.'),
            }),
            execute: async ({ processId }) => {
                const proc = registry.getProcess(processId);


                if (!proc) {
                    return {
                        error: `Process '${processId}' not found. Try using the exact processId from searchProcesses results.`,
                        availableProcesses: registry.listProcesses().map(p => ({ processId: p.processId, name: p.name })),
                    };
                }


                // Return the full node-based process
                return {
                    success: true,
                    processId: proc.processId,
                    processName: proc.processName,
                    description: proc.description,
                    tags: proc.tags,
                    version: proc.version,
                    entryCriteria: proc.entryCriteria,
                    nodes: proc.nodes,
                };
            },
        }),


        /**
         * Search for processes by keywords
         */
        searchProcesses: tool({
            description: 'Find troubleshooting processes that match the given keywords. Searches process names, descriptions, tags, and entry criteria.',
            parameters: z.object({
                keywords: z.string().describe('Keywords to search for in process names, descriptions, and tags'),
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
            description: 'When the user query is ambiguous, ask them to clarify by choosing from predefined options. Never present more than 2 options.',
            parameters: z.object({
                question: z.string().describe('The clarification question to ask the user'),
                options: z.array(z.string()).describe('Array of options for the user to choose from (max 2)'),
            }),
            execute: async ({ question, options }) => {
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

