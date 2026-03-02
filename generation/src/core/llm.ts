/**
 * generation/src/core/llm.ts
 *
 * Thin LLM client for the generation pipeline.
 *
 * Uses the Vercel AI SDK with Azure OpenAI for text generation.
 * Uses the OpenAI SDK directly for Files API (upload/delete only).
 *
 * All pipeline LLM calls go through callLlm() — backoff is handled
 * by the caller via withBackoff() from utils/backoff.ts.
 */

import { generateText } from "ai";
import { azure } from "@ai-sdk/azure";
import OpenAI from "openai";
import { readFileSync } from "fs";
import { basename } from "path";
import { CONFIG } from "./config.js";
import type { StageLogger } from "./logger.js";

// ─── Azure model factory (Vercel AI SDK) ─────────────────────────────────────

function getAzureModel(modelId: string) {
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT_NAME ?? modelId;
  return azure(deployment);
}

// ─── OpenAI client (Files API only) ──────────────────────────────────────────

let _openaiClient: OpenAI | null = null;

function getOpenAiClient(): OpenAI {
  if (!_openaiClient) {
    _openaiClient = new OpenAI({
      apiKey: process.env.AZURE_API_KEY,
      baseURL: `${process.env.AZURE_OPENAI_ENDPOINT}/openai`,
      defaultQuery: {
        "api-version": process.env.AZURE_API_VERSION ?? "2024-12-01-preview",
      },
      defaultHeaders: {
        "api-key": process.env.AZURE_API_KEY ?? "",
      },
    });
  }
  return _openaiClient;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LlmCallOptions {
  /** System prompt text (file content, not a path). */
  system: string;
  /** User message text. */
  prompt: string;
  /** Model string — defaults to CONFIG.models.chunk. */
  model?: string;
  /** Temperature — defaults to CONFIG.temperature.chunk. */
  temperature?: number;
  /** Max output tokens. Default: 16000. */
  maxTokens?: number;
  /** Optional base64-encoded PDF to attach inline (single-pass). */
  pdfBase64?: string;
}

export interface LlmCallResult {
  text: string;
}

// ─── Core call — text only or with inline base64 PDF ─────────────────────────

/**
 * Make a single LLM call.
 * Does NOT retry — wrap with withBackoff() at the call site.
 * For single-pass small PDFs — sends PDF base64 inline.
 */
export async function callLlm(
  opts: LlmCallOptions,
  log: StageLogger,
): Promise<LlmCallResult> {
  const modelId = opts.model ?? CONFIG.models.chunk;
  const temperature = opts.temperature ?? CONFIG.temperature.chunk;
  const maxTokens = opts.maxTokens ?? 16_000;

  const userContent: any[] = [{ type: "text", text: opts.prompt }];

  if (opts.pdfBase64) {
    userContent.push({
      type: "file",
      data: opts.pdfBase64,
      mediaType: "application/pdf",
    });
  }

  log.info("LLM call", {
    model: modelId,
    temperature,
    maxOutputTokens: maxTokens,
  });

  const result = await generateText({
    model: getAzureModel(modelId),
    system: opts.system,
    messages: [{ role: "user", content: userContent }],
    temperature,
    maxOutputTokens: maxTokens,
  });

  log.info("LLM call complete", {
    inputTokens: result.usage?.inputTokens,
    outputTokens: result.usage?.outputTokens,
  });

  return { text: result.text };
}

// ─── Core call — with Files API file_id ───────────────────────────────────────

/**
 * Make a single LLM call referencing an already-uploaded file by file_id.
 * Does NOT retry — wrap with withBackoff() at the call site.
 * For two-pass large PDFs — PDF uploaded once, referenced by ID each call.
 */
export async function callLlmWithFileId(
  opts: LlmCallOptions & { fileId: string },
  log: StageLogger,
): Promise<LlmCallResult> {
  const modelId = opts.model ?? CONFIG.models.chunk;
  const temperature = opts.temperature ?? CONFIG.temperature.chunk;
  const maxTokens = opts.maxTokens ?? 16_000;

  log.info("LLM call with file_id", {
    model: modelId,
    temperature,
    maxOutputTokens: maxTokens,
    fileId: opts.fileId,
  });

  const result = await generateText({
    model: getAzureModel(modelId),
    system: opts.system,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: opts.prompt },
          {
            type: "file",
            data: opts.fileId,
            mediaType: "application/pdf",
          },
        ],
      },
    ],
    temperature,
    maxOutputTokens: maxTokens,
  });

  log.info("LLM call complete", {
    inputTokens: result.usage?.inputTokens,
    outputTokens: result.usage?.outputTokens,
  });

  return { text: result.text };
}

// ─── JSON call ────────────────────────────────────────────────────────────────

/**
 * Make a single LLM call expecting a JSON response.
 * The prompt MUST instruct the model to return JSON.
 * Does NOT retry — wrap with withBackoff() at the call site.
 */
export async function callLlmJson(
  opts: LlmCallOptions,
  log: StageLogger,
): Promise<LlmCallResult> {
  const modelId = opts.model ?? CONFIG.models.quality;
  const temperature = opts.temperature ?? CONFIG.temperature.quality;
  const maxTokens = opts.maxTokens ?? 4_000;

  log.info("LLM JSON call", { model: modelId, maxOutputTokens: maxTokens });

  const result = await generateText({
    model: getAzureModel(modelId),
    system: opts.system,
    messages: [{ role: "user", content: opts.prompt }],
    temperature,
    maxOutputTokens: maxTokens,
  });

  return { text: result.text };
}

// ─── Files API — upload ───────────────────────────────────────────────────────

/**
 * Upload a PDF to the Files API.
 * Returns the file_id to use in subsequent callLlmWithFileId() calls.
 * Called once per PDF at the start of two-pass processing.
 */
export async function uploadPdfToFilesApi(
  pdfPath: string,
  log: StageLogger,
): Promise<string> {
  const client = getOpenAiClient();
  const filename = basename(pdfPath);

  log.info("Uploading PDF to Files API", { filename });

  const fileData = readFileSync(pdfPath);
  const blob = new Blob([fileData], { type: "application/pdf" });
  const file = new File([blob], filename, { type: "application/pdf" });

  const result = await client.files.create({
    file,
    purpose: "assistants",
  });

  log.info("PDF uploaded to Files API", {
    filename,
    file_id: result.id,
  });

  return result.id;
}

// ─── Files API — delete ───────────────────────────────────────────────────────

/**
 * Delete an uploaded file from the Files API.
 * Always called in a finally block after two-pass processing.
 * Failure is non-fatal — logged as warning only.
 */
export async function deletePdfFromFilesApi(
  fileId: string,
  log: StageLogger,
): Promise<void> {
  try {
    const client = getOpenAiClient();
    await client.files.delete(fileId);
    log.info("PDF deleted from Files API", { file_id: fileId });
  } catch (err) {
    log.warn("Failed to delete PDF from Files API — may need manual cleanup", {
      file_id: fileId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─── Prompt loader ────────────────────────────────────────────────────────────

/** Read a prompt file from disk. Returns the raw text verbatim (§12). */
export function loadPromptFile(absolutePath: string): string {
  try {
    return readFileSync(absolutePath, "utf-8");
  } catch (err) {
    throw new Error(
      `[llm] Cannot read prompt file at ${absolutePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
