import {
  deleteProviderKey,
  getProviderKey,
  saveProviderKey,
} from "./secret-store"

// Direct provider credentials stay in protected extension storage and never enter repository files.
import { extractJson } from "./model-provider"
import type { ModelHealth, ModelRequest, ModelResult, PersonalModelProvider } from "./model-provider"

export type BuiltinApiModelDefinition = {
  id: string
  displayName: string
  provider: "gemini" | "deepseek" | "openai"
  defaultModel: string
  origin: string
}

export type BuiltinApiModelConfig = {
  model: string
  rememberKey: boolean
  configured: boolean
  hasKey: boolean
}

export const BUILTIN_API_MODELS: BuiltinApiModelDefinition[] = [
  {
    id: "personal-gemini-api-v1",
    displayName: "Gemini",
    provider: "gemini",
    defaultModel: "gemini-3.5-flash",
    origin: "https://generativelanguage.googleapis.com",
  },
  {
    id: "personal-deepseek-api-v1",
    displayName: "DeepSeek",
    provider: "deepseek",
    defaultModel: "deepseek-v4-flash",
    origin: "https://api.deepseek.com",
  },
  {
    id: "personal-gpt-api-v1",
    displayName: "GPT",
    provider: "openai",
    defaultModel: "gpt-5.6-terra",
    origin: "https://api.openai.com",
  },
]

const API_CONFIG_STORAGE_KEY = "rekeyzeroPersonalApiModelConfigs"

type StoredApiConfig = {
  model: string
  rememberKey: boolean
}

function validStoredConfig(value: unknown): value is StoredApiConfig {
  return Boolean(
    value
    && typeof value === "object"
    && typeof (value as StoredApiConfig).model === "string"
    && (value as StoredApiConfig).model.trim()
    && typeof (value as StoredApiConfig).rememberKey === "boolean",
  )
}

async function storedConfigs(): Promise<Record<string, StoredApiConfig>> {
  const stored = await chrome.storage.local.get(API_CONFIG_STORAGE_KEY)
  const value = stored[API_CONFIG_STORAGE_KEY]
  if (!value || typeof value !== "object") return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, StoredApiConfig] => validStoredConfig(entry[1])),
  )
}

export function builtinApiModel(modelId: string): BuiltinApiModelDefinition {
  const model = BUILTIN_API_MODELS.find((candidate) => candidate.id === modelId)
  if (!model) throw new Error("API model is not supported")
  return model
}

export async function builtinApiModelConfig(modelId: string): Promise<BuiltinApiModelConfig> {
  const definition = builtinApiModel(modelId)
  const configs = await storedConfigs()
  const stored = configs[modelId]
  if (stored?.rememberKey) {
    await getProviderKey(definition.id, definition.origin)
    stored.rememberKey = false
    await chrome.storage.local.set({ [API_CONFIG_STORAGE_KEY]: configs })
  }
  return {
    model: stored?.model ?? definition.defaultModel,
    rememberKey: false,
    configured: Boolean(stored),
    hasKey: Boolean(await getProviderKey(definition.id, definition.origin)),
  }
}

export async function configureBuiltinApiModel(input: {
  modelId: string
  model: string
  rememberKey: boolean
  apiKey?: string
}): Promise<void> {
  const definition = builtinApiModel(input.modelId)
  const model = input.model.trim()
  if (!model) throw new Error("Enter the provider model name")
  const apiKey = input.apiKey?.trim()
  if (apiKey) {
    await saveProviderKey(definition.id, definition.origin, apiKey)
  } else {
    const retained = await getProviderKey(definition.id, definition.origin)
    if (!retained) throw new Error(`Enter the ${definition.displayName} API key`)
  }
  const configs = await storedConfigs()
  configs[definition.id] = { model, rememberKey: false }
  await chrome.storage.local.set({ [API_CONFIG_STORAGE_KEY]: configs })
}

export async function removeBuiltinApiModel(modelId: string): Promise<void> {
  const definition = builtinApiModel(modelId)
  await deleteProviderKey(definition.id)
  const configs = await storedConfigs()
  delete configs[definition.id]
  if (Object.keys(configs).length) {
    await chrome.storage.local.set({ [API_CONFIG_STORAGE_KEY]: configs })
  } else {
    await chrome.storage.local.remove(API_CONFIG_STORAGE_KEY)
  }
}

export async function clearBuiltinApiModels(): Promise<void> {
  await Promise.all(BUILTIN_API_MODELS.map((model) => deleteProviderKey(model.id)))
  await chrome.storage.local.remove(API_CONFIG_STORAGE_KEY)
}

export async function builtinApiHealth(modelId: string): Promise<{
  status: "ready" | "not_ready"
  model: string
  detail: string
}> {
  const definition = builtinApiModel(modelId)
  const config = await builtinApiModelConfig(modelId)
  return config.hasKey
    ? { status: "ready", model: config.model, detail: "Configured in this extension." }
    : { status: "not_ready", model: config.model, detail: `Enter the ${definition.displayName} API key in the extension UI.` }
}

function schemaInstruction(request: ModelRequest): string {
  return request.schema && typeof request.schema === "object"
    ? `\n\nReturn an object that conforms exactly to this JSON Schema: ${JSON.stringify(request.schema)}`
    : ""
}

function providerError(provider: string, status: number): Error {
  if (status === 401 || status === 403) return new Error(`${provider} rejected the API key`)
  if (status === 429) return new Error(`${provider} rate limit was reached`)
  return new Error(`${provider} returned HTTP ${status}`)
}

export class DirectApiProvider implements PersonalModelProvider {
  readonly kind = "external_api" as const
  readonly id: string

  constructor(
    readonly definition: BuiltinApiModelDefinition,
    readonly configuredModel: string,
  ) {
    this.id = definition.id
  }

  async health(): Promise<ModelHealth> {
    return builtinApiHealth(this.id)
  }

  private async requestCompletion(
    request: ModelRequest,
    system: string,
    maxTokens: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const apiKey = await getProviderKey(this.definition.id, this.definition.origin)
    if (!apiKey) throw new Error(`Enter the ${this.definition.displayName} API key in the extension UI`)
    const input = typeof request.input === "string" ? request.input : JSON.stringify(request.input)
    const instructedSystem = `${system}${schemaInstruction(request)}`

    if (this.definition.provider === "gemini") {
      const response = await fetch(
        `${this.definition.origin}/v1beta/models/${encodeURIComponent(this.configuredModel)}:generateContent`,
        {
          method: "POST",
          signal,
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: `System: ${instructedSystem}\n\nUser: ${input}` }] }],
            generationConfig: {
              temperature: 0,
              maxOutputTokens: maxTokens,
              responseMimeType: "application/json",
            },
          }),
        },
      )
      if (!response.ok) throw providerError(this.definition.displayName, response.status)
      const payload = await response.json() as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
      }
      const content = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? ""
      if (!content) throw new Error("Gemini returned no content")
      return content
    }

    const response = await fetch(`${this.definition.origin}${this.definition.provider === "openai" ? "/v1" : ""}/chat/completions`, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(this.definition.provider === "openai" ? {
        model: this.configuredModel,
        max_completion_tokens: Math.max(maxTokens, 1024),
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: instructedSystem },
          { role: "user", content: input },
        ],
      } : {
        model: this.configuredModel,
        temperature: 0,
        max_tokens: Math.max(maxTokens, 1024),
        thinking: { type: "disabled" },
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: instructedSystem },
          { role: "user", content: input },
        ],
      }),
    })
    if (!response.ok) throw providerError(this.definition.displayName, response.status)
    const payload = await response.json() as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>
    }
    const content = payload.choices?.[0]?.message?.content ?? ""
    if (!content) {
      throw new Error(`${this.definition.displayName} returned no content (finish reason: ${payload.choices?.[0]?.finish_reason ?? "unknown"})`)
    }
    return content
  }

  async completeJson<T>(request: ModelRequest, signal?: AbortSignal): Promise<ModelResult<T>> {
    const rawResponses: string[] = []
    const initialMaxTokens = Math.max(request.maxTokens ?? 1024, 1024)
    let content = await this.requestCompletion(request, request.system, initialMaxTokens, signal)
    rawResponses.push(content)
    let output: T
    try {
      output = extractJson<T>(content)
    } catch {
      if (signal?.aborted) throw new DOMException("AI request was cancelled", "AbortError")
      content = await this.requestCompletion(
        request,
        `${request.system}\n\nThe previous response was invalid or incomplete JSON. Return exactly one complete compact JSON object matching the required schema. Do not add commentary or markdown fences.`,
        Math.max(initialMaxTokens, 2048),
        signal,
      )
      rawResponses.push(content)
      try {
        output = extractJson<T>(content)
      } catch {
        const preview = content.slice(0, 500).replace(/\s+/g, " ")
        throw new Error(`AI returned invalid JSON twice. Last response: ${preview}`)
      }
    }

    return {
      output,
      providerId: this.id,
      modelId: this.configuredModel,
      rawResponses,
    }
  }
}

export async function configuredBuiltinApiOrigins(): Promise<string[]> {
  const configs = await storedConfigs()
  return BUILTIN_API_MODELS.filter((model) => configs[model.id]).map((model) => model.origin)
}
