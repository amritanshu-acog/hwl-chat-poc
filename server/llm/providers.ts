import { google } from "@ai-sdk/google";
import { groq } from "@ai-sdk/groq";
import { azure } from "@ai-sdk/azure";
import { logger } from "../core/logger.js";

// ─── Types ─────────────────────────────────────────────────────────────────────

/** Supported provider identifiers */
export type ProviderName = "google" | "groq" | "azure";

/** Configuration for a single provider */
export interface ProviderConfig {
  /** Environment variable name that holds the API key */
  envKey: string;
  /** Factory function that returns an AI SDK model instance */
  createModel: (modelId: string) => ReturnType<typeof google>;
  /** Default model ID to use when none is specified */
  defaultModel: string;
}

// ─── Provider Registry ─────────────────────────────────────────────────────────
/**
 * Registry of all supported providers.
 * To add a new provider:
 *   1. `bun add @ai-sdk/<provider>`
 *   2. Import the provider factory above
 *   3. Add an entry below
 */
const PROVIDERS: Record<ProviderName, ProviderConfig> = {
  google: {
    envKey: "GOOGLE_GENERATIVE_AI_API_KEY",
    createModel: (modelId: string) => google(modelId) as any,
    defaultModel: "gemini-2.5-flash",
  },
  groq: {
    envKey: "GROQ_API_KEY",
    createModel: (modelId: string) => groq(modelId) as any,
    defaultModel: "llama-3.3-70b-versatile",
  },
  azure: {
    envKey: "AZURE_API_KEY",
    createModel: (_modelId: string) => {
      const deployment = process.env.AZURE_OPENAI_DEPLOYMENT_NAME!;
      return azure(deployment) as any;
    },
    defaultModel: "gpt-4o",
  },
};

// ─── Active Provider Resolution ────────────────────────────────────────────────

/**
 * Resolve which provider to use.
 *
 * Priority:
 *   1. `AI_PROVIDER` env var  (e.g. `AI_PROVIDER=azure`)
 *   2. First provider whose API key is present in the environment
 *
 * @returns The resolved provider name
 * @throws If no provider can be resolved
 */
function resolveProviderName(): ProviderName {
  const explicit = process.env.AI_PROVIDER?.toLowerCase() as
    | ProviderName
    | undefined;

  if (explicit && PROVIDERS[explicit]) {
    const key = process.env[PROVIDERS[explicit].envKey];
    if (!key) {
      console.error(
        `❌ AI_PROVIDER is set to "${explicit}" but ${PROVIDERS[explicit].envKey} is missing.`,
      );
      process.exit(1);
    }
    return explicit;
  }

  // Auto-detect: pick the first provider with a valid API key
  for (const [name, config] of Object.entries(PROVIDERS)) {
    if (process.env[config.envKey]) {
      return name as ProviderName;
    }
  }

  console.error(
    "❌ No AI provider API key found. Set one of:",
    Object.values(PROVIDERS)
      .map((p) => p.envKey)
      .join(", "),
  );
  process.exit(1);
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Get the active model instance, resolved from environment configuration.
 *
 * GAP FIX #1/#10: Accepts an optional callModelId so each pipeline stage
 * can specify its own configured model (CONFIG.models.triage, etc.).
 *
 * Model ID resolution priority:
 *   1. callModelId  — set by the call site from CONFIG.models.*
 *   2. AI_MODEL env — global override (useful for quick testing)
 *   3. Provider default model
 *
 * @param callModelId  Optional model ID from the call-site config.
 * @returns An AI SDK–compatible model instance
 */
export function getModel(callModelId?: string) {
  const providerName = resolveProviderName();
  const config = PROVIDERS[providerName];
  const modelId = callModelId ?? process.env.AI_MODEL ?? config.defaultModel;

  logger.debug("Provider resolved", { provider: providerName, model: modelId });

  return config.createModel(modelId);
}

/**
 * List all supported providers and their current availability.
 */
export function listProviders(): Array<{
  name: ProviderName;
  available: boolean;
  defaultModel: string;
}> {
  return Object.entries(PROVIDERS).map(([name, config]) => ({
    name: name as ProviderName,
    available: Boolean(process.env[config.envKey]),
    defaultModel: config.defaultModel,
  }));
}
