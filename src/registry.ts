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
                    const proc = TroubleshootingProcessSchema.parse(data);
                    this.processes.set(proc.processId, proc);


                    console.log(`✓ Loaded: ${proc.processId} (${proc.processName})`);
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
     * Get a specific process by processId, with fallback to fuzzy name match
     */
    getProcess(identifier: string): TroubleshootingProcess | undefined {
        // Try exact processId match first
        const exact = this.processes.get(identifier);
        if (exact) return exact;


        // Fallback: case-insensitive processName match
        const lowerIdentifier = identifier.toLowerCase();
        for (const proc of this.processes.values()) {
            if (proc.processName.toLowerCase() === lowerIdentifier) {
                return proc;
            }
        }


        // Fallback: partial processName match (contains)
        for (const proc of this.processes.values()) {
            if (proc.processName.toLowerCase().includes(lowerIdentifier) ||
                lowerIdentifier.includes(proc.processName.toLowerCase())) {
                return proc;
            }
        }


        // Fallback: slugified name match (convert "Some Name" to "some-name" and compare)
        const slugified = lowerIdentifier.replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
        if (slugified && this.processes.has(slugified)) {
            return this.processes.get(slugified);
        }


        return undefined;
    }


    /**
     * List all available processes
     */
    listProcesses(): Array<{ processId: string; name: string; description: string; tags: string[] }> {
        return Array.from(this.processes.values()).map(p => ({
            processId: p.processId,
            name: p.processName,
            description: p.description,
            tags: p.tags,
        }));
    }


    /**
     * Search processes by keywords (searches name, description, and tags)
     */
    searchProcesses(query: string): Array<{ processId: string; name: string; description: string; tags: string[] }> {
        const lowerQuery = query.toLowerCase();


        // Split query into individual keywords — allow 2+ char words
        const keywords = lowerQuery.split(/\s+/).filter(k => k.length > 1);


        if (keywords.length === 0) {
            return [];
        }


        return Array.from(this.processes.values())
            .filter(p => {
                const searchText = `${p.processId} ${p.processName} ${p.description} ${p.tags.join(' ')}`.toLowerCase();


                // Also check entryCriteria keywords
                const entryKeywords = p.entryCriteria?.keywords?.join(' ') ?? '';
                const fullSearchText = `${searchText} ${entryKeywords}`.toLowerCase();


                // Match if ANY keyword is found
                return keywords.some(keyword => fullSearchText.includes(keyword));
            })
            .map(p => ({
                processId: p.processId,
                name: p.processName,
                description: p.description,
                tags: p.tags,
            }));
    }


    /**
     * Get all processes as a Map
     */
    getAllProcesses(): Map<string, TroubleshootingProcess> {
        return new Map(this.processes);
    }
}

