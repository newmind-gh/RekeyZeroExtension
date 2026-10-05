export type ModelTask = "field_match" | "source_extract"

export type ModelHealth = {
  status: "not_ready" | "ready" | "loading" | "failed" | "unsupported_device"
  detail?: string
}

export type ModelRequest = {
  task: ModelTask
  system: string
  input: unknown
  schema?: Record<string, unknown>
  maxTokens?: number
}

export type ModelResult<T> = {
  output: T
  providerId: string
  modelId: string
  rawResponses: string[]
}

export interface PersonalModelProvider {
  readonly id: string
  readonly kind: "browser_local" | "external_api"
  health(): Promise<ModelHealth>
  completeJson<T>(request: ModelRequest, signal?: AbortSignal): Promise<ModelResult<T>>
}

export function extractJson<T>(value: string): T {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
  try {
    return JSON.parse(trimmed) as T
  } catch {
    const start = trimmed.indexOf("{")
    const end = trimmed.lastIndexOf("}")
    if (start < 0 || end <= start) throw new Error("AI returned invalid JSON")
    return JSON.parse(trimmed.slice(start, end + 1)) as T
  }
}
