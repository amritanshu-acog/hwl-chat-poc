# Troubleshooting System POC

An LLM-powered troubleshooting assistant that extracts process documentation and answers questions strictly based on that knowledge.

## Features

- 📄 Extract troubleshooting processes from PDFs or web pages
- 🤖 LLM-powered process extraction using Google Gemini and Vercel AI SDK
- 💾 Structured JSON storage with Zod validation (Node-based Graph Schema)
- 💬 Interactive chat interface for troubleshooting questions
- 🛠️ Tool-based architecture prevents hallucination by strictly following the process graph
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
- Parse the document (PDF text or HTML content)
- Use LLM to identify troubleshooting processes and convert them into a structured node-based graph
- Save each process as a JSON file in `data/processes/` with a unique ID

### Interactive Chat Mode

Start the troubleshooting assistant:
```bash
bun run chat
```

This will:
- Load all processes from `data/processes/`
- Start an interactive prompt
- Answer questions based strictly on loaded processes
- Guide the user step-by-step through the troubleshooting graph
- Handle clarifications when needed

Example interaction:
```
You: How do I fix a paper jam?
Assistant: I've found a process for "Printer Paper Jam Resolution". 
           First, is the printer displaying an error code?

You: Yes
Assistant: Is the error code 'E-50'?
...
```

### Run Tests

Evaluate the system with predefined test cases:
```bash
bun run test
```

## Architecture

### Components

1. **schemas.ts**: Zod schemas for the node-based process graph structure.
2. **registry.ts**: In-memory storage and retrieval logic for loaded processes.
3. **tools.ts**: Vercel AI SDK tools definitions (`searchProcesses`, `getProcessDetails`, etc.).
4. **llm-client.ts**: Gemini integration using Vercel AI SDK (`generateText`, `streamText`) and system prompts.
5. **extract.ts**: Document parsing (PDF/URL) and extraction orchestration.
6. **main.ts**: CLI entry point and interactive chat loop.

### Process Schema (Node-Based Graph)

The system uses a flexible graph structure where processes are composed of interconnected nodes.

```typescript
// Core Process Structure
{
  processId: string;          // Unique identifier (e.g. "printer-jam-fix")
  processName: string;        // Human readable name
  description: string;        // What this troubleshoots
  tags: string[];            
  version: string;
  entryCriteria: {
    keywords: string[];       // Keywords that trigger this process
    requiredContext: string[];
  };
  nodes: ProcessNode[];       // Array of all nodes in the graph
}

// Node Structure
{
  nodeId: string;             // Unique within process (e.g. "CHECK_POWER")
  type: "question" | "action" | "decision" | "info" | "resolution";
  instruction?: string;       // For actions/info
  question?: string;          // For questions/decisions
  validationHint?: string;    // How to verify answer
  next?: {                    // Branching logic
    "yes": "NODE_ID_1",
    "no": "NODE_ID_2",
    "default": "NODE_ID_3"
  };
  message?: string;           // For resolution nodes
}
```

### LLM Tools

The system provides these tools to prevent hallucination:

- `searchProcesses`: Find processes by keywords (searches name, description, tags, entry criteria).
- `getProcessDetails`: Retrieve the full process graph using a specific `processId`.
- `listAvailableProcesses`: List all loaded processes.
- `askClarification`: Ask the user to clarify if the request is ambiguous.

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
- The LLM acts as an orchestrator, "reading" the graph node-by-node.

### Schema Validation

Zod schemas provide:
- Type safety at runtime
- Validation during extraction (ensuring the LLM outputs valid graphs)
- Guaranteed structure for the chat engine

## Example Process JSON

```json
{
  "processId": "printer-paper-jam",
  "processName": "Printer Paper Jam Resolution",
  "description": "Steps to resolve paper jam errors in office printers",
  "tags": ["printer", "jam", "hardware"],
  "version": "1.0",
  "entryCriteria": {
    "keywords": ["paper jam", "printer stuck", "error code 50"]
  },
  "nodes": [
    {
      "nodeId": "START",
      "type": "question",
      "question": "Is the printer displaying an error code?",
      "next": {
        "yes": "CHECK_CODE",
        "no": "OPEN_TRAY"
      }
    },
    {
      "nodeId": "CHECK_CODE",
      "type": "decision",
      "question": "Is the error code 'E-50'?",
      "next": {
        "yes": "REAR_DOOR",
        "no": "MANUAL_CHECK"
      }
    },
    {
      "nodeId": "OPEN_TRAY",
      "type": "action",
      "instruction": "Open the main paper tray and check for crumpled paper.",
      "next": {
        "default": "IS_CLEARED"
      }
    },
    {
      "nodeId": "IS_CLEARED",
      "type": "question",
      "question": "Did you find and remove any paper?",
      "next": {
        "yes": "RESOLVED",
        "no": "MANUAL_CHECK"
      }
    },
    {
      "nodeId": "RESOLVED",
      "type": "resolution",
      "message": "Paper jam resolved. Print a test page to confirm."
    }
  ]
}
```

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