import { BUILD_LOCAL_AI_FAMILY } from "../../build-profile"
import type { ModelTask } from "./model-provider"

export type LocalModelDefinition = {
  id: string
  displayName: string
  family: "local"
  runtime: "webllm"
  modelArtifact: string
  runtimeAvailable: boolean
  experimental?: boolean
  unavailableReason?: string
  estimatedDownloadBytes: number
  estimatedPeakMemoryMb: number
  maxContextTokens: number
  runtimeContextTokens?: number
  supportedTasks: ModelTask[]
}

const ALL_LOCAL_MODELS: LocalModelDefinition[] = [
  {
    id: "personal-gemma2-2b-it-v1",
    displayName: "Gemma 2 2B · WebLLM",
    family: "local",
    runtime: "webllm",
    modelArtifact: "gemma-2-2b-it-q4f16_1-MLC",
    runtimeAvailable: true,
    estimatedDownloadBytes: 1_490_000_000,
    estimatedPeakMemoryMb: 1_895,
    maxContextTokens: 4096,
    runtimeContextTokens: 2048,
    supportedTasks: ["field_match"],
  },
  {
    id: "personal-qwen25-15b-v1",
    displayName: "Qwen2.5 1.5B · WebLLM",
    family: "local",
    runtime: "webllm",
    modelArtifact: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
    runtimeAvailable: true,
    estimatedDownloadBytes: 880_000_000,
    estimatedPeakMemoryMb: 1_630,
    maxContextTokens: 4096,
    supportedTasks: ["field_match"],
  },
]

export const LOCAL_MODELS: LocalModelDefinition[] = BUILD_LOCAL_AI_FAMILY === "local"
  ? ALL_LOCAL_MODELS
  : []

export const DEFAULT_LOCAL_MODEL_ID = LOCAL_MODELS.find(
  (model) => model.id === "personal-qwen25-15b-v1",
)?.id ?? LOCAL_MODELS[0]?.id ?? null

export function localModel(modelId: string) {
  const model = LOCAL_MODELS.find((candidate) => candidate.id === modelId)
  if (!model) throw new Error("Local AI model is not supported by this build")
  return model
}
