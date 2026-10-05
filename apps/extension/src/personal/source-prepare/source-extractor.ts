import type { PersonalModelProvider } from "../ai/model-provider"
import type { ExtractableSourceField, ParsedDocument } from "./source-prepare-session"
import { sourceExtractionRequest } from "./source-extraction-prompt"

export async function extractSourceFields(provider: PersonalModelProvider, fields: ExtractableSourceField[], documents: ParsedDocument[], signal: AbortSignal): Promise<unknown> {
  // Never use the matching/logging services: this task contains document values.
  const result = await provider.completeJson<unknown>(sourceExtractionRequest(fields, documents), signal)
  return result.output
}
