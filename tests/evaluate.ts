import { ProcessRegistry } from '../src/registry.js';
import { createTools } from '../src/tools.js';
import { answerTroubleshootingQuestion } from '../src/llm-client.js';

/**
 * Test cases to evaluate the system
 */
const testCases = [
    {
        name: 'Clear Question',
        query: 'How do I fix a paper jam?',
        expectedBehavior: 'Should directly provide steps from the paper jam process',
    },
    {
        name: 'Ambiguous Question',
        query: 'The printer is not working',
        expectedBehavior: 'Should ask for clarification about the specific issue',
    },
    {
        name: 'Out of Scope',
        query: 'How do I install Microsoft Word?',
        expectedBehavior: 'Should clearly state this information is not available',
    },
    {
        name: 'Process Listing',
        query: 'What problems can you help me with?',
        expectedBehavior: 'Should list all available processes',
    },
];

/**
 * Run evaluation tests
 */
async function runEvaluation() {
    console.log('🧪 Running Evaluation Tests\n');
    console.log('='.repeat(60));

    // Load processes
    const registry = new ProcessRegistry();
    await registry.loadProcesses();

    if (registry.listProcesses().length === 0) {
        console.error('❌ No processes loaded. Run extraction first.');
        process.exit(1);
    }

    console.log(`\n✓ Loaded ${registry.listProcesses().length} processes\n`);

    const tools = createTools(registry);

    // Run each test case
    let testIndex = 1;
    for (const testCase of testCases) {
        console.log(`\nTest ${testIndex++}: ${testCase.name}`);
        console.log('-'.repeat(60));
        console.log(`Query: "${testCase.query}"`);
        console.log(`Expected: ${testCase.expectedBehavior}\n`);

        try {
            const result = await answerTroubleshootingQuestion(testCase.query, tools);

            console.log('Response:');
            let response = '';
            for await (const chunk of result.textStream) {
                process.stdout.write(chunk);
                response += chunk;
            }
            console.log('\n');

            // Basic evaluation
            const hasHallucination = response.toLowerCase().includes('step') &&
                !response.toLowerCase().includes('process');

            if (hasHallucination) {
                console.log('⚠️  Warning: Possible hallucination detected');
            } else {
                console.log('✓ Response appears valid');
            }

        } catch (error) {
            console.error('❌ Test failed:', error);
        }

        console.log('='.repeat(60));
    }

    console.log('\n✅ Evaluation complete\n');
}

// Run evaluation
runEvaluation().catch(console.error);