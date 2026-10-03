import type { MappingProfile } from "../transfer/types"

export type ScalarValue = string | number | boolean | null

export type PageControl = {
  control_id: string
  tag: string
  type: string
  role: string
  name: string
  label: string
  label_text?: string
  group_text?: string
  placeholder: string
  required: boolean
  disabled: boolean
  current_value: ScalarValue
  checked: boolean | null
  options: Array<{ value: string; label: string }>
}

export type PersonalHomeData = {
  profiles: MappingProfile[]
}

export type PersonalAiSettingsView = {
  selectedModelId?: string | null
  localModelEnabled: boolean
  localModelId: string | null
  localModelStatus: "not_ready" | "ready" | "loading" | "failed" | "unsupported_device"
  localModelDetail?: string
  localModels: Array<{
    id: string
    displayName: string
    modelArtifact: string
    runtimeAvailable: boolean
    experimental: boolean
    unavailableReason?: string
    status: "not_ready" | "ready" | "loading" | "failed" | "unsupported_device"
    detail?: string
    estimatedDownloadBytes: number
    estimatedPeakMemoryMb: number
  }>
  apiModelId?: string | null
  apiModels?: Array<{
    id: string
    displayName: string
    provider: "gemini" | "deepseek" | "openai"
    origin: string
    model: string
    status: "ready" | "not_ready"
    detail?: string
    configured: boolean
    hasKey: boolean
    rememberKey: boolean
  }>
}
