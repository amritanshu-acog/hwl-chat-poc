# Future Roadmap: Multimodal & Conversational Ingestion

This document outlines the technical strategy for expanding the troubleshooting engine to ingest knowledge from **Videos** and **Support Conversations**.

## 1. Video Ingestion Pipeline (Tutorials & Screen Recordings)

Troubleshooting information often lives in YouTube tutorials, Loom videos, or internal training recordings.

### The Pipeline

`Video File` → `Audio Transcription` + `Visual Keyframes` → `Multimodal LLM Processing` → `JSON Graph`

### Implementation Strategy

1.  **Audio Transcription (Speech-to-Text)**
    - **Tool**: OpenAI Whisper (local/API) or Google generic ASR.
    - **Goal**: Convert the spoken instructions into a timestamped text transcript.
    - **Why**: Most troubleshooting steps are spoken ("First, click on settings...").

2.  **Visual Analysis (OCR & Action Detection)**
    - **Tool**: Multimodal LLM (e.g., Gemini 1.5 Pro, GPT-4o).
    - **Goal**: Extract text from screen shares (error codes, menu items) and identify physical actions (e.g., "User is unplugging the cable").
    - **Method**: Sample video frames every 2-5 seconds.

3.  **Synthesis & Extraction**
    - Feed both the **Transcript** and **Visual Descriptions** into the existing Extraction LLM.
    - _Prompt Adjustment_: "Map the spoken instructions to the visual actions. If the audio says 'click this', use the visual context to identify 'this'."

### Challenges

- **Synchronization**: Matching "do this" in audio to the exact visual step.
- **Implicit Context**: Videos often skip "obvious" steps that need to be explicit in a text graph.

---

## 2. Support Conversation Ingestion (Slack, Discord, Zendesk)

Valuable "tribal knowledge" exists in solved tickets and chat threads, often covering edge cases not in official docs.

### The Pipeline

`Raw Chat Logs` → `Thread Segmentation` → `PII & Noise Cleaning` → `Resolution Extraction` → `JSON Graph`

### Implementation Strategy

1.  **Connectors & Ingestion**
    - **Sources**: Slack API (channels), Zendesk API (solved tickets), Discord dumps.
    - **Filter**: Only ingest threads marked as "Solved" or reacted to with ✅.

2.  **Preprocessing & Diarization**
    - **noise**: Remove system messages, "good morning", scheduler bots.
    - **Anonymization**: **CRITICAL**. Use a local NLP library (like Presidio) to strip names, emails, and IP addresses _before_ sending to any LLM.

3.  **"Resolution Extraction" Pass**
    - Since conversations are messy and non-linear, we need an intermediate LLM step.
    - _Prompt_: "Summarize this conversation into a clean Q&A format. What was the root symptom? What was the final working solution? Ignore the failed attempts unless they are useful diagnostic steps."

4.  **Graph Generation**
    - Take the Clean Summary and feed it into the main `User Query` → `JSON Graph` extractor.

### Challenges

- **Ambiguity**: Users often say "It works now!" without specifying _which_ of the 5 suggested fixes actually worked.
- **Outdated Info**: Old threads may contain deprecated solutions. We need a "Confidence Score" or "Freshness Decay".
- **Context Fragmentation**: A solution might link to a private image or DM ("I DM'd you the fix"), creating a dead end.

---

## 3. Visual PDF Ingestion (Diagrams & Screenshots)

The current text-only extraction fails when instructions rely on visual cues ("Click the red circle," "Click here," "See Figure 2.1").

### The Problem

- **Missing Context**: Standard PDF parsing extracts text but discards images. "Click the button shown below" becomes meaningless text without the image.
- **Spatial References**: Instructions like "top-left connector" rely on visual diagrams.

### The Solution: Vision-Language Models (VLM)

Instead of extracting _text_, we convert PDF pages to **Images** and process them with a Multimodal LLM (like Gemini 1.5 Pro or GPT-4o).

### Implementation Strategy

1.  **PDF-to-Image Conversion**
    - **Tool**: `pdf2pic` or `poppler-utils`.
    - **Action**: Render each page as a high-resolution PNG/JPEG.

2.  **Multimodal Extraction Pipeline**
    - **Input**: Feed the **Page Image** directly to the LLM.
    - **Prompt**:
      > "Analyze this technical guide page. Transcribe the instructions. If text references a visual element (e.g., 'click here', 'see diagram'), DESCRIBE that visual element explicitly in the text."

3.  **Enriched Node Generation**
    - **Old**: `instruction: "Click the reset button."` (Ambiguous)
    - **New**: `instruction: "Click the small red 'Reset' button located on the back panel, near the power cord."` (Descriptive)

4.  **Image Snippet Storage** (Advanced)
    - **Crop & Store**: Extract the relevant diagram crop.
    - **Link**: Store `image_url` or base64 blob in the JSON node.
    - **Display**: Show this image in the Chat UI when the step is active.

### Challenges

- **Cost**: Processing images is more expensive (tokens) than text.
- **Pagination**: Instructions flowing across page breaks break the "one image per prompt" context. Requires handling multi-page contexts.
  ;

---

## 4. Human-in-the-Loop Verification (The "Staging Area")

Automating ingestion from these noisy sources introduces a higher risk of incorrect or dangerous instructions.

**Proposed Workflow:**

1.  **Ingest**: Video/Chat processed into JSON Graph.
2.  **Tagging**: System tags the process as `source:video-auto` or `source:slack-thread`.
3.  **Staging Mode**: These processes are saved to a `data/staging/` directory, NOT `data/processes/`.
4.  **Admin Review**: A human expert reviews the generated graph.
    - Correct? -> Move to `data/processes/`.
    - Incorrect? -> Edit or Delete.

## 5. Unified Knowledge Schema

We will need to update `schemas.ts` to track provenance across these diverse sources.

```typescript
type ProcessMetadata = {
  // Core Identity
  processId: string;
  sourceType: "document_text" | "document_visual" | "video" | "conversation";

  // Provenance (Where did this come from?)
  sourceUrl?: string; // Link to PDF, YouTube URL, or Slack Thread permalink
  sourceId?: string; // File hash, Video ID, or Ticket #
  authorOrUser?: string; // Who wrote the doc or solved the ticket

  // Granular Context (Deep linking support)
  mediaContext?: {
    videoTimestamp?: number; // Start time in seconds (for Video)
    pageNumber?: number; // Page number (for Visual PDF)
    imageUrl?: string; // URL/Path to extracted diagram or keyframe
    messageId?: string; // Specific message ID (for Chat/Slack)
  };

  // Quality & Governance
  confidenceScore: number; // 0.0 to 1.0 (e.g., 0.95 for Official Docs, 0.6 for Slack threads)
  verifiedByHuman: boolean; // Has an admin reviewed this in the Staging Area?
  extractionDate: string; // ISO Date
};
```

---
