import {
  deleteProviderKey,
  getProviderKey,
  saveProviderKey,
} from "./secret-store"

// Direct provider credentials stay in protected extension storage and never enter repository files.
import { extractJson } from "./model-provider"
import type { ModelHealth, ModelRequest, ModelResult, PersonalModelProvider } from "./model-provider"
import type { ModelTask } from "./model-provider"

export type BuiltinApiModelOption = {
  id: string
  displayName: string
  costTier: "free" | "lowest_cost" | "standard" | "premium"
  recommended?: boolean
}

export type BuiltinApiModelDefinition = {
  id: string
  displayName: string
  provider: "gemini" | "deepseek" | "openai" | "anthropic"
  protocol: "gemini" | "openai_compatible" | "anthropic"
  supportedTasks: readonly ModelTask[]
  defaultModel: string
  defaultReason: "free_tier" | "lowest_cost"
  models: readonly BuiltinApiModelOption[]
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
    protocol: "gemini",
    supportedTasks: ["field_match", "source_extract"],
    defaultModel: "gemini-3.5-flash-lite",
    defaultReason: "free_tier",
    models: [
      { id: "gemini-3.5-flash-lite", displayName: "Gemini 3.5 Flash-Lite", costTier: "free", recommended: true },
      { id: "gemini-3.5-flash", displayName: "Gemini 3.5 Flash", costTier: "standard" },
      { id: "gemini-3.6-flash", displayName: "Gemini 3.6 Flash", costTier: "standard" },
      { id: "gemini-3.8-flash", displayName: "Gemini 3.8 Flash", costTier: "standard" },
    ],
    origin: "https://generativelanguage.googleapis.com",
  },
  {
    id: "personal-gpt-api-v1",
    displayName: "OpenAI",
    provider: "openai",
    protocol: "openai_compatible",
    supportedTasks: ["field_match", "source_extract"],
    defaultModel: "gpt-5.6-luna",
    defaultReason: "lowest_cost",
    models: [
      { id: "gpt-5.6-luna", displayName: "GPT-5.6 Luna", costTier: "lowest_cost", recommended: true },
      { id: "gpt-5.6-terra", displayName: "GPT-5.6 Terra", costTier: "standard" },
      { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", costTier: "premium" },
    ],
    origin: "https://api.openai.com",
  },
  {
    id: "personal-claude-api-v1",
    displayName: "Claude",
    provider: "anthropic",
    protocol: "anthropic",
    supportedTasks: ["field_match", "source_extract"],
    defaultModel: "claude-haiku-4-5",
    defaultReason: "lowest_cost",
    models: [
      { id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5", costTier: "lowest_cost", recommended: true },
      { id: "claude-sonnet-5-5", displayName: "Claude Sonnet 5.5", costTier: "standard" },
      { id: "claude-opus-5-5", displayName: "Claude Opus 5.5", costTier: "premium" },
    ],
    origin: "https://api.anthropic.com",
  },
  {
    id: "personal-deepseek-api-v1",
    displayName: "DeepSeek",
    provider: "deepseek",
    protocol: "openai_compatible",
    supportedTasks: ["field_match", "source_extract"],
    defaultModel: "deepseek-flash",
    defaultReason: "lowest_cost",
    models: [
      { id: "deepseek-flash", displayName: "DeepSeek V4.1 Flash", costTier: "lowest_cost", recommended: true },
      { id: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro", costTier: "premium" },
    ],
    origin: "https://api.deepseek.com",
  },
]

const API_CONFIG_STORAGE_KEY = "rekeyzeroPersonalApiModelConfigs"

type StoredApiConfig = {
  model: string
  rememberKey: boolean
}

const LEGACY_PROVIDER_MODELS: Record<string, Record<string, string>> = {
  "personal-deepseek-api-v1": {
    "deepseek-v4-flash": "deepseek-flash",
    "deepseek-v41-flash": "deepseek-flash",
    "deepseek-v4-flash-vision-exp": "deepseek-flash",
  },
}

function normalizeStoredModel(definition: BuiltinApiModelDefinition, model: string): string {
  const trimmed = model.trim()
  const migrated = LEGACY_PROVIDER_MODELS[definition.id]?.[trimmed] ?? trimmed
  return definition.models.some((option) => option.id === migrated) ? migrated : definition.defaultModel
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
  const configs = Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, StoredApiConfig] => validStoredConfig(entry[1])),
  )
  let changed = false
  for (const definition of BUILTIN_API_MODELS) {
    const config = configs[definition.id]
    if (!config) continue
    const model = normalizeStoredModel(definition, config.model)
    if (config.rememberKey) await getProviderKey(definition.id, definition.origin)
    if (model !== config.model || config.rememberKey) {
      configs[definition.id] = { model, rememberKey: false }
      changed = true
    }
  }
  if (changed) await chrome.storage.local.set({ [API_CONFIG_STORAGE_KEY]: configs })
  return configs
}

export function builtinApiModel(modelId: string): BuiltinApiModelDefinition {
  const model = BUILTIN_API_MODELS.find((candidate) => candidate.id === modelId)
  if (!model) throw new Error("API model is not supported")
  return model
}

export function builtinApiModelOption(definition: BuiltinApiModelDefinition, modelId: string): BuiltinApiModelOption {
  const option = definition.models.find((model) => model.id === modelId)
  if (!option) throw new Error(`Choose a supported ${definition.displayName} model`)
  return option
}

export async function builtinApiModelConfig(modelId: string): Promise<BuiltinApiModelConfig> {
  const definition = builtinApiModel(modelId)
  const configs = await storedConfigs()
  const stored = configs[modelId]
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
  builtinApiModelOption(definition, model)
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

// Claude accepts minItems only up to 1 and does not accept maxItems. The original
// schema remains in the system instruction; matching validation stays unchanged.
function anthropicSchema(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  const schema = { ...value as Record<string, unknown> }
  if (schema.type === "array") {
    const constraints: string[] = []
    if (typeof schema.minItems === "number" && schema.minItems > 1) {
      constraints.push(`At least ${schema.minItems} items.`)
      schema.minItems = 1
    }
    if (typeof schema.maxItems === "number") {
      constraints.push(`At most ${schema.maxItems} items.`)
      delete schema.maxItems
    }
    if (constraints.length) schema.description = [schema.description, ...constraints].filter(Boolean).join(" ")
  }
  if (schema.type === "object" && schema.additionalProperties === undefined) schema.additionalProperties = false
  for (const key of ["properties", "$defs", "definitions"]) {
    const children = schema[key]
    if (children && typeof children === "object" && !Array.isArray(children)) {
      schema[key] = Object.fromEntries(Object.entries(children).map(([name, child]) => [name, anthropicSchema(child)]))
    }
  }
  if (schema.items) schema.items = anthropicSchema(schema.items)
  for (const key of ["anyOf", "allOf", "oneOf"]) {
    if (Array.isArray(schema[key])) schema[key] = schema[key].map(anthropicSchema)
  }
  return schema
}

export class DirectApiProvider implements PersonalModelProvider {
  readonly kind = "external_api" as const
  readonly id: string

  constructor(
    readonly definition: BuiltinApiModelDefinition,
    readonly configuredModel: string,
  ) {
    builtinApiModelOption(definition, configuredModel)
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

    switch (this.definition.protocol) {
      case "gemini": {
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

      case "anthropic": {
        const response = await fetch(`${this.definition.origin}/v1/messages`, {
          method: "POST",
          signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: this.configuredModel,
            max_tokens: Math.max(maxTokens, 1024),
            system: instructedSystem,
            messages: [{ role: "user", content: input }],
            ...(request.schema && typeof request.schema === "object" ? {
              output_config: { format: { type: "json_schema", schema: anthropicSchema(request.schema) } },
            } : {}),
          }),
        })
        if (!response.ok) throw providerError(this.definition.displayName, response.status)
        const payload = await response.json() as {
          content?: Array<{ type?: string; text?: string }>
          stop_reason?: string
        }
        const content = payload.content?.filter((block) => block.type === "text")
          .map((block) => block.text ?? "").join("") ?? ""
        if (!content) throw new Error(`Claude returned no content (stop reason: ${payload.stop_reason ?? "unknown"})`)
        return content
      }

      case "openai_compatible": {
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
    }
  }

  async completeJson<T>(request: ModelRequest, signal?: AbortSignal): Promise<ModelResult<T>> {
    if (!this.definition.supportedTasks.includes(request.task)) throw new Error("This model does not support this AI task")
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
        if (request.task === "source_extract") throw new Error("AI returned invalid extraction JSON twice")
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
