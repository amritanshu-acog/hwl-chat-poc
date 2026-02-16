import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import fetch from 'node-fetch';
import { extractProcessesFromDocument } from './llm-client.js';
import { TroubleshootingProcessSchema } from './schemas.js';


/**
* Extract text from a PDF file
*/
async function extractFromPdf(filePath: string): Promise<string> {
    console.log(`Reading PDF: ${filePath}`);


    const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');


    const dataBuffer = await readFile(filePath);
    const uint8Array = new Uint8Array(dataBuffer);
    const loadingTask = pdfjsLib.getDocument({ data: uint8Array });
    const pdfDocument = await loadingTask.promise;


    let fullText = '';


    for (let i = 1; i <= pdfDocument.numPages; i++) {
        const page = await pdfDocument.getPage(i);
        const textContent = await page.getTextContent();
        const pageText = textContent.items.map((item: any) => item.str).join(' ');
        fullText += pageText + '\n';
    }


    return fullText;
}


/**
* Extract text from a web URL
*/
async function extractFromUrl(url: string): Promise<string> {
    console.log(`Fetching URL: ${url}`);
    const response = await fetch(url);
    const text = await response.text();


    // Basic HTML stripping (for simple cases)
    return text
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}


/**
* Main extraction function
*/
async function extract(source: string) {
    try {
        // Determine if source is URL or file path
        let text: string;
        if (source.startsWith('http://') || source.startsWith('https://')) {
            text = await extractFromUrl(source);
        } else {
            text = await extractFromPdf(source);
        }


        console.log(`\nExtracted ${text.length} characters\n`);


        // Use LLM to extract processes
        const processes = await extractProcessesFromDocument(text);


        if (processes.length === 0) {
            console.log('No processes found in document');
            return;
        }


        console.log(`Found ${processes.length} process(es)\n`);


        // Ensure output directory exists
        const outputDir = join(process.cwd(), 'data', 'processes');
        await mkdir(outputDir, { recursive: true });


        // Save each process as a separate JSON file
        for (const proc of processes) {
            try {
                // Validate against schema
                const validatedProcess = TroubleshootingProcessSchema.parse(proc);


                const fileName = `${validatedProcess.processId}.json`;
                const filePath = join(outputDir, fileName);


                await writeFile(
                    filePath,
                    JSON.stringify(validatedProcess, null, 2),
                    'utf-8'
                );


                console.log(`✓ Saved: ${fileName}`);
                console.log(`  Name: ${validatedProcess.processName}`);
                console.log(`  Description: ${validatedProcess.description}`);
                console.log(`  Nodes: ${validatedProcess.nodes.length}`);
                console.log(`  Tags: ${validatedProcess.tags.join(', ')}\n`);
            } catch (error) {
                console.error(`✗ Failed to save process:`, error);
            }
        }


        console.log(`\nExtraction complete! Processes saved to ${outputDir}`);
    } catch (error) {
        console.error('Extraction failed:', error);
        process.exit(1);
    }
}


// CLI execution
const source = process.argv[2];
if (!source) {
    console.error('Usage: bun run extract <pdf-file-path-or-url>');
    process.exit(1);
}


extract(source);



