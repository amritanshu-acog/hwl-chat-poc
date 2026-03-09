import { getFallback } from "../resources/resources.js";
import { logger } from "../core/logger.js";

/**
 * Return the static fallback content (default.md) to serve when no knowledge
 * base match exists. This raw text is passed through the formatter before being
 * returned to the caller — same path as any other response.
 *
 * Falls back to an inline string if default.md cannot be read, so the pipeline
 * never hard-fails on a missing fallback file.
 */
export async function getFallbackContent(): Promise<string> {
  try {
    return await getFallback();
  } catch (err) {
    logger.error("Failed to load default.md — using inline fallback", { err });
    return (
      "I'm sorry, I couldn't find an answer to your question in the " +
      "knowledge base. Please contact support for further assistance."
    );
  }
}
