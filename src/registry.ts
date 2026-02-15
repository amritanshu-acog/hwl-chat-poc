import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { type TroubleshootingProcess, TroubleshootingProcessSchema } from './schemas.js';

/**
 * In-memory registry for troubleshooting processes
 */
export class ProcessRegistry {
    private processes: Map<string, TroubleshootingProcess> = new Map();

    /**
     * Load all processes from the data/processes directory
     */
    async loadProcesses(): Promise<void> {
        const processDir = join(process.cwd(), 'data', 'processes');

        try {
            const files = await readdir(processDir);
            const jsonFiles = files.filter(f => f.endsWith('.json'));

            console.log(`Loading ${jsonFiles.length} process files...`);

            for (const file of jsonFiles) {
                try {
                    const filePath = join(processDir, file);
                    const content = await readFile(filePath, 'utf-8');
                    const data = JSON.parse(content);

                    // Validate against schema
                    const process = TroubleshootingProcessSchema.parse(data);
                    this.processes.set(process.processName, process);

                    console.log(`✓ Loaded: ${process.processName}`);
                } catch (error) {
                    console.error(`✗ Failed to load ${file}:`, error);
                }
            }

            console.log(`\nTotal processes loaded: ${this.processes.size}\n`);
        } catch (error) {
            console.error('Error loading processes:', error);
            throw error;
        }
    }

    /**
     * Get a specific process by name
     */
    getProcess(name: string): TroubleshootingProcess | undefined {
        return this.processes.get(name);
    }

    /**
     * List all available process names
     */
    listProcesses(): Array<{ name: string; description: string }> {
        return Array.from(this.processes.values()).map(p => ({
            name: p.processName,
            description: p.description,
        }));
    }

    /**
     * Search processes by keywords (searches individual words, not exact phrase)
     */
    searchProcesses(query: string): Array<{ name: string; description: string }> {
        const lowerQuery = query.toLowerCase();

        // Split query into individual keywords
        const keywords = lowerQuery.split(/\s+/).filter(k => k.length > 2); // Only words 3+ chars

        if (keywords.length === 0) {
            return [];
        }

        return Array.from(this.processes.values())
            .filter(p => {
                const searchText = `${p.processName} ${p.description}`.toLowerCase();

                // Match if ANY keyword is found
                return keywords.some(keyword => searchText.includes(keyword));
            })
            .map(p => ({
                name: p.processName,
                description: p.description,
            }));
    }

    /**
     * Get all processes as a Map
     */
    getAllProcesses(): Map<string, TroubleshootingProcess> {
        return new Map(this.processes);
    }
}