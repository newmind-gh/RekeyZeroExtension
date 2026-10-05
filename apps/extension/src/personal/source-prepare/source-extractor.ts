import type { PersonalModelProvider } from "../ai/model-provider"
import type { ExtractableSourceField, PreparedDocument } from "./source-prepare-session"
import { sourceExtractionRequest } from "./source-extraction-prompt"
import { validatePreparedDocuments } from "./document-converter"

export async function extractSourceFields(provider: PersonalModelProvider, fields: ExtractableSourceField[], documents: PreparedDocument[], signal: AbortSignal): Promise<unknown> {
  // Never use the matching/logging services: this task contains document values.
  validatePreparedDocuments(documents)
  const result = await provider.completeJson<unknown>(sourceExtractionRequest(fields, documents), signal)
  return result.output
}
