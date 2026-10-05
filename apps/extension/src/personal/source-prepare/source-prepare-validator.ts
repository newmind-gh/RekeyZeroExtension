import type { Field } from "../../transfer/types"
import type { ParsedDocument, SourceExtractionDecision, SourcePrepareFieldResult } from "./source-prepare-session"

const compact = (text: string) => text.replace(/\s+/g, " ").trim()
export function validateSourceExtraction(output: unknown, fields: Array<{ fieldKey: string; field: Field }>, documents: ParsedDocument[]): SourcePrepareFieldResult[] {
  const decisions = output && typeof output === "object" && "decisions" in output ? output.decisions : null
  if (!Array.isArray(decisions) || decisions.length > fields.length * 2) throw new Error("AI returned an invalid extraction result")
  return fields.map(({ fieldKey }) => {
    const matches = decisions.filter((decision) => decision && typeof decision === "object" && decision.fieldKey === fieldKey)
    if (!matches.length) return { fieldKey, status: "not_found" }
    if (matches.length !== 1) return { fieldKey, status: "invalid" }
    const decision = matches[0] as SourceExtractionDecision
    if (Object.keys(decision).some((key) => !["fieldKey", "value", "status", "evidence"].includes(key))) return { fieldKey, status: "invalid" }
    if (decision.status === "not_found" || decision.status === "ambiguous") {
      return { fieldKey, status: decision.value === null ? decision.status : "invalid" }
    }
    if (decision.status !== "found" || decision.value === null || !["string", "number", "boolean"].includes(typeof decision.value)
      || (typeof decision.value === "number" && !Number.isFinite(decision.value))
      || !Array.isArray(decision.evidence) || !decision.evidence.length || decision.evidence.length > 5) return { fieldKey, status: "invalid" }
    const evidence = decision.evidence.flatMap((reference) => {
      if (!reference || typeof reference !== "object" || typeof reference.quote !== "string" || !compact(reference.quote) || reference.quote.length > 400) return []
      const document = documents.find((candidate) => candidate.id === reference.documentId)
      const page = reference.page ?? undefined
      if (!document || (page !== undefined && (!Number.isInteger(page) || page < 1))) return []
      const candidates = document.pages.filter((candidate) => page === undefined || candidate.page === page)
      if (!candidates.some((candidate) => compact(candidate.text).includes(compact(reference.quote)))) return []
      return [{ documentId: document.id, documentName: document.name, ...(page === undefined ? {} : { page }), quote: compact(reference.quote) }]
    })
    return evidence.length === decision.evidence.length
      ? { fieldKey, status: "filled", extractedValue: decision.value, evidence }
      : { fieldKey, status: "invalid" }
  })
}
