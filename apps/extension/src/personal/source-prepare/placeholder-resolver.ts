import { PRIVACY_PLACEHOLDER } from "./privacy-types"
import type { PreparedDocument, SourcePrepareFieldResult } from "./source-prepare-session"

function ownersOf(result: SourcePrepareFieldResult, documents: PreparedDocument[]): PreparedDocument[] {
  const value = result.extractedValue
  if (typeof value !== "string") return []
  return (result.evidence ?? []).flatMap((reference) => {
    const document = documents.find((candidate) => candidate.id === reference.documentId)
    if (!document || !reference.quote.includes(value) || !Object.hasOwn(document.privacy.entityMap, value)
      || !document.privacy.findings.some((finding) => finding.placeholder === value)) return []
    return [document]
  })
}

export function validExtractionPlaceholder(result: SourcePrepareFieldResult, documents: PreparedDocument[]): boolean {
  const value = result.extractedValue
  if (value === null || value === undefined) return false
  if (typeof value !== "string") return true
  if (!PRIVACY_PLACEHOLDER.test(value)) {
    // Atomic values only. Reject token fragments and composite/mangled tokens.
    if (/[\[\]]|\b(?:PERSON|ADDRESS|EMAIL|PHONE|IP_ADDRESS|SSN|CREDIT_CARD|IBAN|SECRET|API_KEY|AU_TFN|AU_MEDICARE|AU_ABN|AU_ACN)[_-]\d+\b/.test(value)
      || documents.some((document) => document.privacy.findings.some((finding) => value.includes(finding.placeholder)))) return false
    return true
  }
  const owners = ownersOf(result, documents)
  return owners.length > 0 && owners.every((document) => document.privacy.entityMap[value] === owners[0].privacy.entityMap[value])
}

// Call only after schema, field and evidence validation. Never mutate the raw response.
export function resolveSourceExtraction(results: SourcePrepareFieldResult[], documents: PreparedDocument[]): SourcePrepareFieldResult[] {
  return results.map((result) => {
    if (result.status !== "filled") return { ...result }
    if (!validExtractionPlaceholder(result, documents)) return { fieldKey: result.fieldKey, status: "invalid" }
    const value = result.extractedValue!
    const resolvedValue = typeof value === "string" && PRIVACY_PLACEHOLDER.test(value)
      ? ownersOf(result, documents)[0].privacy.entityMap[value] : value
    return { ...result, resolvedValue }
  })
}
