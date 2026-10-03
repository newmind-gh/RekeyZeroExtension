export type PersonalSettings = {
  id: "personal"
  localModelId: string | null
  localModelEnabled: boolean
  apiModelId?: string | null
}

export type PersonalLlmLogMatch = {
  control_id: string
  target_label: string
  information_path: string
  source_label: string
}

export type PersonalLlmLog = {
  id: string
  createdAt: string
  task: "field_match" | "runtime_error"
  target: string
  providerId: string
  modelId: string
  status?: "success" | "error"
  request_type?: string
  error?: {
    message: string
    stack?: string
  }
  exact_matches: PersonalLlmLogMatch[]
  raw_request?: unknown | null
  ai_request?: unknown | null
  raw_response: string
  parsed_mappings: unknown[]
  rejected_mappings: unknown[]
  final_mappings: PersonalLlmLogMatch[]
}

export const PERSONAL_STORES = [
  "settings",
  "transfer_mapping_profiles",
  "llm_logs",
] as const

export type PersonalStoreName = (typeof PERSONAL_STORES)[number]
