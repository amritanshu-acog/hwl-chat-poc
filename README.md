# Troubleshooting System POC

An LLM-powered troubleshooting assistant that extracts process documentation and answers questions strictly based on that knowledge.

## Features

- 📄 Extract troubleshooting processes from PDFs or web pages
- 🤖 LLM-powered process extraction using Google Gemini
- 💾 Structured JSON storage with Zod validation
- 💬 Interactive chat interface for troubleshooting questions
- 🛠️ Tool-based architecture prevents hallucination
- ✅ Strict adherence to documented processes

## Prerequisites

- Node.js 18+ or Bun
- Google Gemini API key

## Setup

1. **Install dependencies**:
```bash
   bun install
```

2. **Configure environment**:
```bash
   cp .env.example .env
   # Edit .env and add your GOOGLE_GENERATIVE_AI_API_KEY
```

3. **Create data directories**:
```bash
   mkdir -p data/processes
```

## Usage

### Extract Processes from Document

Extract troubleshooting processes from a PDF:
```bash
bun run extract path/to/document.pdf
```

Or from a URL:
```bash
bun run extract https://example.com/troubleshooting-guide
```

This will:
- Parse the document
- Use LLM to identify troubleshooting processes
- Save each process as a JSON file in `data/processes/`

### Interactive Chat Mode

Start the troubleshooting assistant:
```bash
bun run chat
```

This will:
- Load all processes from `data/processes/`
- Start an interactive prompt
- Answer questions based strictly on loaded processes
- Handle clarifications when needed

Example interaction:
```
You: How do I fix a paper jam?
Assistant: I'll help you with the paper jam issue. Here are the steps...

You: exit
```

### Run Tests

Evaluate the system with predefined test cases:
```bash
bun run test
```

## Architecture

### Components

1. **schemas.ts**: Zod schemas for type-safe process definitions
2. **registry.ts**: In-memory storage for loaded processes
3. **tools.ts**: LLM tools for process discovery and retrieval
4. **llm-client.ts**: Gemini integration with system prompts
5. **extract.ts**: Document parsing and process extraction
6. **main.ts**: Interactive chat orchestration

### Process Schema
```typescript
{
  processName: string          // Unique identifier
  description: string          // What this troubleshoots
  prerequisites: string[]      // Requirements before starting
  steps: [{
    stepNumber: number
    instruction: string
    condition: string | null
    possibleOutcomes: string[]
  }]
  decisionPoints: [{
    question: string
    options: [{
      answer: string
      nextStep: number
    }]
  }]
  expectedResolution: string   // Success criteria
}
```

### LLM Tools

The system provides these tools to prevent hallucination:

- `listAvailableProcesses`: Discover what processes exist
- `getProcessDetails`: Retrieve full process JSON
- `searchProcesses`: Find processes by keywords
- `askClarification`: Handle ambiguous queries

## Key Design Decisions

### Strict Knowledge Boundaries

The LLM is constrained to ONLY use information from loaded JSON files. This prevents:
- Invented steps
- Hallucinated information
- Answers outside the knowledge base

### Tool-Based Architecture

Using Vercel AI SDK tools ensures:
- Structured access to processes
- Traceable information flow
- Clear separation between retrieval and generation

### Schema Validation

Zod schemas provide:
- Type safety at runtime
- Clear process structure
- Validation during extraction

## Example Process JSON
```json
{
  "processName": "printer-paper-jam",
  "description": "Steps to resolve paper jam errors",
  "prerequisites": [
    "Printer is powered on",
    "Access to printer internals"
  ],
  "steps": [
    {
      "stepNumber": 1,
      "instruction": "Turn off printer and unplug",
      "condition": null,
      "possibleOutcomes": ["Printer powers down"]
    }
  ],
  "decisionPoints": [
    {
      "question": "Can you see the jammed paper?",
      "options": [
        { "answer": "Yes", "nextStep": 3 },
        { "answer": "No", "nextStep": 5 }
      ]
    }
  ],
  "expectedResolution": "Printer prints test page"
}
```

## Testing

See `tests/test-cases.md` for detailed test scenarios including:
- Clear questions
- Ambiguous queries
- Out-of-scope requests
- Multi-turn conversations
- Conditional logic paths

## Limitations

- No database (in-memory only)
- No web server (CLI only)
- Basic PDF text extraction
- Simple HTML stripping for web pages

## Future Enhancements

- Vector database for semantic search
- Support for more document formats
- Web interface
- Multi-language support
- Process versioning

## License

MIT
```

### .gitignore
```
# Dependencies
node_modules/
bun.lockb

# Environment
.env

# Generated data
data/processes/*.json

# Build output
dist/
*.tsbuildinfo

# Logs
*.log

# OS
.DS_Store
Thumbs.db