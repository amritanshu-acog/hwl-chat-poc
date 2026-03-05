// /**
//  * generation/core/assistant.ts
//  *
//  * Isolated Azure OpenAI Assistants API client for two-pass chunking.
//  *
//  * The rest of the pipeline uses the Vercel AI SDK (via llm.ts).
//  * This module exists solely because Chat Completions cannot reference
//  * a pre-uploaded file_id — only the Assistants API can do that.
//  *
//  * Lifecycle for one PDF:
//  *   1. createAssistantSession(fileId, systemPrompt) → session handle
//  *   2. runAssistantQuery(session, userPrompt)       → response text  (call N times)
//  *   3. cleanupAssistantSession(session)             → deletes assistant + thread
//  */

// import OpenAI from "openai";
// import type { StageLogger } from "./logger.js";
// import { CONFIG } from "./config.js";

// // ─── Types ────────────────────────────────────────────────────────────────────

// export interface AssistantSession {
//   client: OpenAI;
//   assistantId: string;
//   threadId: string;
//   fileId: string;
// }

// export interface AssistantQueryOptions {
//   /** User message to send to the assistant. */
//   prompt: string;
//   /** Max time (ms) to wait for the run to complete. Default: 300_000 (5 min). */
//   timeoutMs?: number;
// }

// export interface AssistantQueryResult {
//   text: string;
//   inputTokens: number;
//   outputTokens: number;
// }

// // ─── Client ───────────────────────────────────────────────────────────────────

// let _client: OpenAI | null = null;

// function getClient(): OpenAI {
//   if (!_client) {
//     _client = new OpenAI({
//       apiKey: process.env.AZURE_API_KEY,
//       baseURL: `${process.env.AZURE_OPENAI_ENDPOINT}/openai`,
//       defaultQuery: {
//         "api-version": process.env.AZURE_API_VERSION ?? "2024-12-01-preview",
//       },
//       defaultHeaders: {
//         "api-key": process.env.AZURE_API_KEY ?? "",
//       },
//     });
//   }
//   return _client;
// }

// // ─── Create session ───────────────────────────────────────────────────────────

// /**
//  * Create a temporary Assistant with file_search enabled, attach the uploaded
//  * file to a new vector store, and create a dedicated Thread.
//  *
//  * The returned session handle is passed to runAssistantQuery() and
//  * cleanupAssistantSession().
//  */
// export async function createAssistantSession(
//   fileId: string,
//   systemPrompt: string,
//   log: StageLogger,
// ): Promise<AssistantSession> {
//   const client = getClient();
//   const model = CONFIG.models.chunk;

//   log.info("Creating assistant session", { fileId, model });

//   // 1. Create a vector store with the uploaded file so file_search can use it
//   const vectorStore = await client.vectorStores.create({
//     name: `chunk-session-${Date.now()}`,
//     file_ids: [fileId],
//   });

//   log.info("Vector store created", {
//     vectorStoreId: vectorStore.id,
//     fileId,
//   });

//   // 2. Poll until the vector store has finished indexing the file
//   let vs = vectorStore;
//   const pollStart = Date.now();
//   const maxPollMs = 120_000; // 2 minutes max

//   while (vs.status === "in_progress" && Date.now() - pollStart < maxPollMs) {
//     await new Promise<void>((r) => setTimeout(r, 2_000));
//     vs = await client.vectorStores.retrieve(vectorStore.id);
//     log.info("Polling vector store status", { status: vs.status });
//   }

//   if (vs.file_counts?.completed === 0) {
//     log.warn("Vector store file indexing may not have completed", {
//       status: vs.status,
//       fileCounts: vs.file_counts,
//     });
//   }

//   // 3. Create the Assistant with file_search tool and link the vector store
//   const assistant = await client.beta.assistants.create({
//     name: `chunk-extractor-${Date.now()}`,
//     instructions: systemPrompt,
//     model,
//     tools: [{ type: "file_search" }],
//     tool_resources: {
//       file_search: {
//         vector_store_ids: [vectorStore.id],
//       },
//     },
//     temperature: CONFIG.temperature.chunk,
//   });

//   log.info("Assistant created", { assistantId: assistant.id });

//   // 4. Create a Thread for the conversation
//   const thread = await client.beta.threads.create();

//   log.info("Thread created", { threadId: thread.id });

//   return {
//     client,
//     assistantId: assistant.id,
//     threadId: thread.id,
//     fileId,
//   };
// }

// // ─── Run a query (same thread — accumulates history) ─────────────────────────

// /**
//  * Send a user prompt to the assistant thread and wait for the response.
//  * The assistant already has access to the PDF via file_search.
//  *
//  * NOTE: Each call appends to the shared thread, so input tokens grow with
//  * every message. Use runAssistantQueryFreshThread() for independent calls
//  * (e.g. per-section extraction) to keep token costs flat.
//  *
//  * Returns the assistant's text response and token usage.
//  */
// export async function runAssistantQuery(
//   session: AssistantSession,
//   opts: AssistantQueryOptions,
//   log: StageLogger,
// ): Promise<AssistantQueryResult> {
//   const { client, assistantId, threadId } = session;
//   const timeoutMs = opts.timeoutMs ?? 300_000;

//   // 1. Add the user message to the thread
//   await client.beta.threads.messages.create(threadId, {
//     role: "user",
//     content: opts.prompt,
//   });

//   log.info("Assistant query: message added", {
//     threadId,
//     promptLength: opts.prompt.length,
//   });

//   // 2. Create a run and poll until it completes
//   const run = await client.beta.threads.runs.createAndPoll(threadId, {
//     assistant_id: assistantId,
//   });

//   log.info("Assistant query: run completed", {
//     runId: run.id,
//     status: run.status,
//     usage: run.usage,
//   });

//   if (run.status !== "completed") {
//     const errorMsg = `Assistant run failed with status: ${run.status}`;
//     log.error(errorMsg, {
//       runId: run.id,
//       lastError: run.last_error,
//     });
//     throw new Error(errorMsg);
//   }

//   // 3. Retrieve the assistant's response messages
//   const messages = await client.beta.threads.messages.list(threadId, {
//     run_id: run.id,
//     order: "asc",
//   });

//   // Extract text from all assistant messages in this run
//   const textParts: string[] = [];
//   for (const msg of messages.data) {
//     if (msg.role === "assistant") {
//       for (const block of msg.content) {
//         if (block.type === "text") {
//           // Strip annotation markers (file citations) that file_search adds
//           let text = block.text.value;
//           if (block.text.annotations?.length) {
//             for (const ann of block.text.annotations) {
//               text = text.replace(ann.text, "");
//             }
//           }
//           textParts.push(text);
//         }
//       }
//     }
//   }

//   const responseText = textParts.join("\n");
//   const inputTokens = run.usage?.prompt_tokens ?? 0;
//   const outputTokens = run.usage?.completion_tokens ?? 0;

//   log.info("Assistant query: response received", {
//     responseLength: responseText.length,
//     inputTokens,
//     outputTokens,
//   });

//   return { text: responseText, inputTokens, outputTokens };
// }

// // ─── Run a query (fresh thread — flat token cost per call) ───────────────────

// /**
//  * Like runAssistantQuery, but creates a brand-new thread for each call.
//  * The assistant and its vector store are reused, so the PDF is not re-indexed.
//  *
//  * Use this for per-section extraction in two-pass mode:
//  *   - Each section gets clean context (system prompt + that section's prompt only)
//  *   - Input tokens stay flat across all sections instead of growing per call
//  *   - Discards the thread immediately after the run completes
//  */
// export async function runAssistantQueryFreshThread(
//   session: AssistantSession,
//   opts: AssistantQueryOptions,
//   log: StageLogger,
// ): Promise<AssistantQueryResult> {
//   const { client, assistantId } = session;

//   // Create a fresh thread — no previous messages
//   const thread = await client.beta.threads.create();
//   log.info("Fresh thread created for section", { threadId: thread.id });

//   try {
//     // Add user message and run
//     await client.beta.threads.messages.create(thread.id, {
//       role: "user",
//       content: opts.prompt,
//     });

//     log.info("Assistant query (fresh thread): message added", {
//       threadId: thread.id,
//       promptLength: opts.prompt.length,
//     });

//     const run = await client.beta.threads.runs.createAndPoll(thread.id, {
//       assistant_id: assistantId,
//     });

//     log.info("Assistant query (fresh thread): run completed", {
//       runId: run.id,
//       status: run.status,
//       usage: run.usage,
//     });

//     if (run.status !== "completed") {
//       const errorMsg = `Assistant run failed with status: ${run.status}`;
//       log.error(errorMsg, { runId: run.id, lastError: run.last_error });
//       throw new Error(errorMsg);
//     }

//     const messages = await client.beta.threads.messages.list(thread.id, {
//       run_id: run.id,
//       order: "asc",
//     });

//     const textParts: string[] = [];
//     for (const msg of messages.data) {
//       if (msg.role === "assistant") {
//         for (const block of msg.content) {
//           if (block.type === "text") {
//             let text = block.text.value;
//             if (block.text.annotations?.length) {
//               for (const ann of block.text.annotations) {
//                 text = text.replace(ann.text, "");
//               }
//             }
//             textParts.push(text);
//           }
//         }
//       }
//     }

//     const responseText = textParts.join("\n");
//     const inputTokens = run.usage?.prompt_tokens ?? 0;
//     const outputTokens = run.usage?.completion_tokens ?? 0;

//     log.info("Assistant query (fresh thread): response received", {
//       responseLength: responseText.length,
//       inputTokens,
//       outputTokens,
//     });

//     return { text: responseText, inputTokens, outputTokens };
//   } finally {
//     // Clean up the ephemeral thread — don't leave dangling resources
//     try {
//       await client.beta.threads.delete(thread.id);
//       log.info("Fresh thread deleted", { threadId: thread.id });
//     } catch (err) {
//       log.warn("Failed to delete fresh thread", {
//         threadId: thread.id,
//         error: err instanceof Error ? err.message : String(err),
//       });
//     }
//   }
// }

// // ─── Cleanup ──────────────────────────────────────────────────────────────────

// /**
//  * Delete the temporary Assistant, Thread, and associated vector store.
//  * Failures are logged as warnings — never thrown (called from finally blocks).
//  *
//  * The uploaded file_id is NOT deleted here — that is still handled by
//  * deletePdfFromFilesApi() in llm.ts for backward compatibility.
//  */
// export async function cleanupAssistantSession(
//   session: AssistantSession,
//   log: StageLogger,
// ): Promise<void> {
//   const { client, assistantId, threadId } = session;

//   // Retrieve vector store IDs from the assistant before deleting it
//   let vectorStoreIds: string[] = [];
//   try {
//     const assistant = await client.beta.assistants.retrieve(assistantId);
//     vectorStoreIds =
//       assistant.tool_resources?.file_search?.vector_store_ids ?? [];
//   } catch (err) {
//     log.warn("Failed to retrieve assistant for vector store cleanup", {
//       assistantId,
//       error: err instanceof Error ? err.message : String(err),
//     });
//   }

//   // Delete the thread
//   try {
//     await client.beta.threads.delete(threadId);
//     log.info("Thread deleted", { threadId });
//   } catch (err) {
//     log.warn("Failed to delete thread — may need manual cleanup", {
//       threadId,
//       error: err instanceof Error ? err.message : String(err),
//     });
//   }

//   // Delete the assistant
//   try {
//     await client.beta.assistants.delete(assistantId);
//     log.info("Assistant deleted", { assistantId });
//   } catch (err) {
//     log.warn("Failed to delete assistant — may need manual cleanup", {
//       assistantId,
//       error: err instanceof Error ? err.message : String(err),
//     });
//   }

//   // Delete the vector store(s)
//   for (const vsId of vectorStoreIds) {
//     try {
//       await client.vectorStores.delete(vsId);
//       log.info("Vector store deleted", { vectorStoreId: vsId });
//     } catch (err) {
//       log.warn("Failed to delete vector store — may need manual cleanup", {
//         vectorStoreId: vsId,
//         error: err instanceof Error ? err.message : String(err),
//       });
//     }
//   }
// }
