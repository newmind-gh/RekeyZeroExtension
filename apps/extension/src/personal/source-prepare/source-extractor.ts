import type { PersonalModelProvider } from "../ai/model-provider"
import type { ExtractableSourceField, PreparedDocument } from "./source-prepare-session"
import { sourceExtractionRequest } from "./source-extraction-prompt"
import { validatePreparedDocuments } from "./document-converter"

export async function extractSourceFields(provider: PersonalModelProvider, fields: ExtractableSourceField[], documents: PreparedDocument[], signal: AbortSignal): Promise<unknown> {
  // Never use the matching/logging services: this task contains document values.
  validatePreparedDocuments(documents)
  if (provider.kind === "browser_local") {
    const decisions: unknown[] = []
    // Keep output within small local model context windows without dropping evidence.
    for (const field of fields) {
      if (signal.aborted) throw new Error("Source preparation was cancelled")
      const request = sourceExtractionRequest([field], documents)
      request.maxTokens = 512
      const result = await provider.completeJson<{ decisions: unknown[] }>(request, signal)
      if (!result.output || !Array.isArray(result.output.decisions)) throw new Error("AI returned an invalid extraction result")
      decisions.push(...result.output.decisions)
    }
    return { decisions }
  }
  const result = await provider.completeJson<unknown>(sourceExtractionRequest(fields, documents), signal)
  return result.output
}
