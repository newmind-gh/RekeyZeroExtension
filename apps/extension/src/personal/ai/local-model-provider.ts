import {
  CreateMLCEngine,
  deleteModelAllInfoInCache,
  hasModelInCache,
} from "@mlc-ai/web-llm"
import type { MLCEngine } from "@mlc-ai/web-llm"

import { localModel } from "./model-registry"
import { extractJson } from "./model-provider"
import type {
  ModelHealth,
  ModelRequest,
  ModelResult,
  PersonalModelProvider,
} from "./model-provider"

export type LocalModelStatus = ModelHealth & {
  modelId: string
  progress?: number
}

type LocalChatMessage = {
  role: "system" | "user" | "assistant"
  content: string
}

type FieldMatchContract = {
  targets: string[]
  sources: Array<string | null>
}

type CanonicalFieldMatchDecision = {
  target: string
  source: string | null
}

type CanonicalFieldMatchOutput = {
  decisions: CanonicalFieldMatchDecision[]
}

let engine: MLCEngine | null = null
let loadedModelId: string | null = null
let loading: Promise<MLCEngine> | null = null
let loadingModelId: string | null = null
let progress = 0
let operationTail: Promise<void> = Promise.resolve()

async function runExclusive<T>(operation: () => Promise<T>): Promise<T> {
  const previous = operationTail
  let release!: () => void
  operationTail = new Promise<void>((resolve) => { release = resolve })
  await previous
  try {
    return await operation()
  } finally {
    release()
  }
}

function isModelNotLoadedError(error: unknown): boolean {
  return error instanceof Error
    && error.message.includes("Model not loaded before trying to complete")
}

function isFatalLocalEngineError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  return [
    "device was lost",
    "dxgi_error_device_removed",
    "failed to execute 'requestdevice' on 'gpuadapter'",
    "cannot pass deleted object",
    "object has already been disposed",
  ].some((text) => message.includes(text))
}

function webgpuAvailable(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function enumValues(value: unknown): Array<string | null> {
  const definition = asRecord(value)
  if (!definition || !Array.isArray(definition.enum)) return []
  return definition.enum.filter((candidate): candidate is string | null => candidate === null || typeof candidate === "string")
}

function fieldMatchContract(request: ModelRequest): FieldMatchContract | null {
  if (request.task !== "field_match" || !request.schema) return null
  const rootProperties = asRecord(request.schema.properties)
  const decisions = asRecord(rootProperties?.decisions)
  const items = asRecord(decisions?.items)
  const itemProperties = asRecord(items?.properties)
  const targets = enumValues(itemProperties?.target).filter((value): value is string => typeof value === "string")
  const sources = enumValues(itemProperties?.source)
  return targets.length > 0 && sources.length > 0 ? { targets, sources } : null
}

function normalizedAlias(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, "")
}

function resolveIdentity(
  value: unknown,
  allowed: string[],
  kind: "target" | "source",
): string | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= allowed.length) {
    return allowed[value - 1]
  }
  if (typeof value !== "string") return null
  const trimmed = value.trim().replace(/^['"]|['"]$/g, "")
  const normalized = normalizedAlias(trimmed)
  const prefix = kind === "target" ? "t" : "s"
  const longPrefix = kind
  const indexedMatch = normalized.match(new RegExp(`^(?:${prefix}|${longPrefix})(\\d+)$`))
  if (indexedMatch) {
    const index = Number(indexedMatch[1])
    return index >= 1 && index <= allowed.length ? allowed[index - 1] : null
  }

  const normalizedMatches = allowed.filter((candidate) => normalizedAlias(candidate) === normalized)
  if (normalizedMatches.length === 1) return normalizedMatches[0]

  const withoutType = trimmed.replace(/\s*\[type:[^\]]+\]\s*$/i, "")
  const labelMatches = allowed.filter((candidate) =>
    normalizedAlias(candidate.split(" | section: ", 1)[0]) === normalizedAlias(withoutType)
  )
  return labelMatches.length === 1 ? labelMatches[0] : null
}

function nullLikeSource(value: unknown): boolean {
  return value === null || (typeof value === "string" && ["", "null", "none", "nomatch", "n/a", "na"].includes(
    value.trim().toLowerCase().replace(/[\s_-]+/g, ""),
  ))
}

function canonicalDecision(
  value: unknown,
  allowedTargets: Set<string>,
  allowedSources: Set<string | null>,
): CanonicalFieldMatchDecision | null {
  const decision = asRecord(value)
  if (!decision) return null

  const targetValue = decision.target ?? decision.target_field ?? decision.target_id ?? decision.target_index
  const source = Object.prototype.hasOwnProperty.call(decision, "source")
    ? decision.source
    : Object.prototype.hasOwnProperty.call(decision, "source_field")
      ? decision.source_field
      : Object.prototype.hasOwnProperty.call(decision, "source_id")
        ? decision.source_id
        : Object.prototype.hasOwnProperty.call(decision, "source_index")
          ? decision.source_index
      : null

  const target = resolveIdentity(targetValue, [...allowedTargets], "target")
  if (!target || !allowedTargets.has(target)) return null
  if (nullLikeSource(source)) return { target, source: null }
  const resolvedSource = resolveIdentity(source, [...allowedSources].filter((value): value is string => value !== null), "source")
  if (!resolvedSource || !allowedSources.has(resolvedSource)) return null
  return { target, source: resolvedSource }
}

function decisionsFromExactMap(
  value: unknown,
  allowedTargets: Set<string>,
  allowedSources: Set<string | null>,
): CanonicalFieldMatchDecision[] | null {
  const map = asRecord(value)
  if (!map) return null
  const entries = Object.entries(map)
  if (!entries.length) return null
  const decisions: CanonicalFieldMatchDecision[] = []
  for (const [target, source] of entries) {
    const decision = canonicalDecision({ target, source }, allowedTargets, allowedSources)
    if (!decision) return null
    decisions.push(decision)
  }
  return decisions
}

function canonicalizeFieldMatchOutput(
  contract: FieldMatchContract,
  output: unknown,
): CanonicalFieldMatchOutput | null {
  const allowedTargets = new Set(contract.targets)
  const allowedSources = new Set<string | null>(contract.sources)
  const unwrapped = Array.isArray(output)
    && output.length === 1
    && asRecord(output[0])
    && ["decisions", "matches", "mappings"].some((key) => Object.prototype.hasOwnProperty.call(output[0], key))
    ? output[0]
    : output
  const root = asRecord(unwrapped)

  let rawDecisions: unknown[] | null = null
  if (Array.isArray(unwrapped)) {
    rawDecisions = unwrapped
  } else if (root) {
    if (Array.isArray(root.decisions)) rawDecisions = root.decisions
    else if (root.decisions !== undefined) {
      const one = canonicalDecision(root.decisions, allowedTargets, allowedSources)
      if (one) rawDecisions = [root.decisions]
      else {
        const mapped = decisionsFromExactMap(root.decisions, allowedTargets, allowedSources)
        if (mapped) rawDecisions = mapped
      }
    }

    if (!rawDecisions && Array.isArray(root.matches)) rawDecisions = root.matches
    if (!rawDecisions && Array.isArray(root.mappings)) rawDecisions = root.mappings
    if (!rawDecisions && root.matches !== undefined) {
      const mapped = decisionsFromExactMap(root.matches, allowedTargets, allowedSources)
      if (mapped) rawDecisions = mapped
    }
    if (!rawDecisions && root.mappings !== undefined) {
      const mapped = decisionsFromExactMap(root.mappings, allowedTargets, allowedSources)
      if (mapped) rawDecisions = mapped
    }
    if (!rawDecisions && canonicalDecision(root, allowedTargets, allowedSources)) rawDecisions = [root]
    if (!rawDecisions) {
      const mapped = decisionsFromExactMap(root, allowedTargets, allowedSources)
      if (mapped) rawDecisions = mapped
    }
  }
  if (!rawDecisions) return null

  const byTarget = new Map<string, string | null>()
  for (const value of rawDecisions) {
    const decision = canonicalDecision(value, allowedTargets, allowedSources)
    if (!decision) return null
    if (byTarget.has(decision.target)) {
      const existing = byTarget.get(decision.target) ?? null
      if (existing !== decision.source) byTarget.set(decision.target, null)
      continue
    }
    byTarget.set(decision.target, decision.source)
  }

  // Missing targets are a safe format repair: null means "no semantic match" and never
  // invents a source. Unknown targets/sources and duplicates are rejected above.
  return {
    decisions: contract.targets.map((target) => ({
      target,
      source: byTarget.get(target) ?? null,
    })),
  }
}

function parseWebLlmOutput<T>(request: ModelRequest, content: string): T {
  const output = extractJson<unknown>(content)
  const contract = fieldMatchContract(request)
  if (!contract) return output as T

  const canonical = canonicalizeFieldMatchOutput(contract, output)
  if (!canonical) {
    throw new Error("Local AI returned JSON that cannot be safely normalized to the required field-match contract")
  }
  return canonical as T
}

function webLlmSystemPrompt(request: ModelRequest): string {
  if (request.task === "source_extract") {
    return `${request.system}\n\nReturn JSON matching this schema exactly:\n${JSON.stringify(request.schema)}\nUse the supplied fieldKey and documentId values, not field-matching t-IDs or s-IDs.`
  }
  const contract = fieldMatchContract(request)
  if (!contract) return request.system

  return `${request.system}\n\nWEBLLM OUTPUT CONTRACT — follow literally:\nThe user message assigns compact IDs t1, t2, ... to target fields and s1, s2, ... to source fields.\nReturn exactly one JSON object with this shape: {"decisions":[{"target":"t1","source":"s1"},{"target":"t2","source":null}]}\nUse only the keys "decisions", "target", and "source". Include every target ID exactly once. Choose only a listed source ID or null.\nDo not repeat field labels, wrap the object in an array, use markdown fences, or add commentary.`
}

export class LocalModelProvider implements PersonalModelProvider {
  readonly id = "personal-local-lite"
  readonly kind = "browser_local" as const

  constructor(readonly modelId: string) {}

  async health(): Promise<LocalModelStatus> {
    const definition = localModel(this.modelId)
    if (!webgpuAvailable()) {
      return { status: "unsupported_device", modelId: this.modelId, detail: "WebGPU unavailable" }
    }
    if (engine && loadedModelId === this.modelId) return { status: "ready", modelId: this.modelId }
    if (loading && loadingModelId === this.modelId) {
      return { status: "loading", modelId: this.modelId, progress }
    }
    if (!definition.runtimeAvailable) {
      return { status: "failed", modelId: this.modelId, detail: definition.unavailableReason }
    }
    const cached = await hasModelInCache(definition.modelArtifact)
    return {
      status: cached ? "ready" : "not_ready",
      modelId: this.modelId,
      detail: cached ? "Downloaded; loads when needed" : "Not downloaded",
    }
  }

  async load(): Promise<void> {
    localModel(this.modelId)
    await runExclusive(async () => { await this.engine() })
  }

  async delete(): Promise<void> {
    const definition = localModel(this.modelId)
    await runExclusive(async () => {
      if (engine && loadedModelId === this.modelId) {
        await engine.unload()
        engine = null
        loadedModelId = null
      }
      if (definition.runtimeAvailable) {
        await deleteModelAllInfoInCache(definition.modelArtifact)
      }
    })
  }

  async completeJson<T>(request: ModelRequest, signal?: AbortSignal): Promise<ModelResult<T>> {
    localModel(this.modelId)
    return runExclusive(async () => {
      let failedEngine: MLCEngine | null = null
      try {
        if (signal?.aborted) throw new DOMException("Local AI request was cancelled", "AbortError")
        const activeEngine = await this.engine()
        failedEngine = activeEngine
        const baseMessages: LocalChatMessage[] = [
          { role: "system", content: webLlmSystemPrompt(request) },
          {
            role: "user",
            content: typeof request.input === "string" ? request.input : JSON.stringify(request.input),
          },
        ]
        // Do not use WebLLM response_format/schema here. That path enables xgrammar's
        // GrammarMatcher, which can leave a disposed WASM object behind and crash later
        // requests. Field matching receives its compact JSON contract in the system prompt;
        // safe shape deviations are canonicalized locally. Unknown identities and unsafe
        // structures still retry once and then fail closed.
        const options = {
          temperature: 0,
          max_tokens: request.maxTokens ?? 512,
        }
        const complete = async (messages: LocalChatMessage[]) => {
          try {
            return await activeEngine.chat.completions.create({ messages, ...options })
          } catch (error) {
            if (!isModelNotLoadedError(error)) throw error
            await this.reload(activeEngine)
            return activeEngine.chat.completions.create({ messages, ...options })
          }
        }
        const response = await complete(baseMessages)
        let content = response.choices[0]?.message.content
        if (!content) throw new Error("Local AI returned no result")
        const rawResponses = [content]
        let output: T
        try {
          output = parseWebLlmOutput<T>(request, content)
        } catch {
          if (signal?.aborted) throw new DOMException("Local AI request was cancelled", "AbortError")
          const retry = await complete([
            ...baseMessages,
            { role: "user", content: request.task === "source_extract"
              ? "Return only one JSON object matching the extraction schema. Include fieldKey, status, value, and evidence for each supplied field. Use verbatim document quotes; use not_found with null and empty evidence if unsupported. No markdown or commentary."
              : "Return only one compact JSON object with a decisions array. Use each listed t-ID exactly once and only a listed s-ID or null. Do not repeat labels, add markdown, or add commentary." },
          ])
          content = retry.choices[0]?.message.content
          if (!content) throw new Error("Local AI returned no result on retry")
          rawResponses.push(content)
          try { output = parseWebLlmOutput<T>(request, content) }
          catch {
            if (request.task === "source_extract") throw new Error("AI returned invalid extraction JSON twice")
            const error = new Error("Local AI returned an unsafe or invalid field-match format twice. Try creating the Fill Setup again.") as Error & { rawResponses: string[] }
            error.rawResponses = rawResponses
            throw error
          }
        }
        return {
          output,
          providerId: this.id,
          modelId: this.modelId,
          rawResponses,
        }
      } catch (error) {
        if (request.task === "source_extract" && error instanceof Error && /context.{0,30}(window|length|size)|exceed.{0,30}(token|context)/i.test(error.message)) {
          throw new Error("These documents exceed the selected local model's context window. Use shorter documents or select an API model.")
        }
        if (!isFatalLocalEngineError(error)) throw error
        this.invalidate(failedEngine)
        const detail = error instanceof Error ? error.message : "Unknown WebGPU error"
        throw new Error(`Local AI GPU session was lost. The model will be reloaded on the next attempt. Original error: ${detail}`)
      }
    })
  }

  private invalidate(activeEngine: MLCEngine | null): void {
    if (activeEngine && engine !== activeEngine) return
    engine = null
    loadedModelId = null
  }

  private async reload(activeEngine: MLCEngine): Promise<void> {
    const definition = localModel(this.modelId)
    loadedModelId = null
    try {
      await activeEngine.reload(definition.modelArtifact, {
        context_window_size: definition.runtimeContextTokens ?? definition.maxContextTokens,
      })
      engine = activeEngine
      loadedModelId = this.modelId
    } catch (error) {
      if (engine === activeEngine) engine = null
      throw error
    }
  }

  private async engine(): Promise<MLCEngine> {
    if (!webgpuAvailable()) throw new Error("Local AI requires WebGPU")
    if (engine && loadedModelId === this.modelId) return engine
    if (loading && loadingModelId === this.modelId) return loading
    const definition = localModel(this.modelId)
    if (definition.runtime !== "webllm") throw new Error("This Local AI model does not use WebLLM")
    if (!definition.runtimeAvailable) {
      throw new Error(definition.unavailableReason ?? "This Local AI model is unavailable")
    }
    if (engine) {
      await engine.unload()
      engine = null
      loadedModelId = null
    }
    loadingModelId = this.modelId
    loading = CreateMLCEngine(
      definition.modelArtifact,
      {
        initProgressCallback: (report) => {
          progress = Math.max(0, Math.min(1, report.progress))
        },
      },
      { context_window_size: definition.runtimeContextTokens ?? definition.maxContextTokens },
    )
    try {
      engine = await loading
      loadedModelId = this.modelId
      return engine
    } finally {
      loading = null
      loadingModelId = null
    }
  }
}
