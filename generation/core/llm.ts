/**
 * generation/core/llm.ts
 *
 * Thin LLM client for the generation pipeline.
 *
 * Uses the Vercel AI SDK with Azure OpenAI for all text generation.
 * All PDF content is passed as base64 inline — no Files API dependency.
 */

import { generateText } from "ai";
import { azure } from "@ai-sdk/azure";
import { readFileSync } from "fs";
import { CONFIG } from "./config.js";
import type { StageLogger } from "./logger.js";

// ─── Azure model factory (Vercel AI SDK) ─────────────────────────────────────

function getAzureModel(modelId: string) {
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT_NAME ?? modelId;
  return azure(deployment);
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LlmCallOptions {
  system: string;
  prompt: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  pdfBase64?: string;
}

export interface LlmCallResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

// ─── Core call — text only or with inline base64 PDF ─────────────────────────

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

  return {
    text: result.text,
    inputTokens: result.usage?.inputTokens ?? 0,
    outputTokens: result.usage?.outputTokens ?? 0,
  };
}

// ─── JSON call ────────────────────────────────────────────────────────────────

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

  return {
    text: result.text,
    inputTokens: result.usage?.inputTokens ?? 0,
    outputTokens: result.usage?.outputTokens ?? 0,
  };
}

// ─── Prompt loader ────────────────────────────────────────────────────────────

export function loadPromptFile(absolutePath: string): string {
  try {
    return readFileSync(absolutePath, "utf-8");
  } catch (err) {
    throw new Error(
      `[llm] Cannot read prompt file at ${absolutePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
