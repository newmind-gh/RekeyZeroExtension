import type { Field, Observation, Value } from "../../transfer/types"

export type ParsedDocument = {
  id: string
  name: string
  mediaType: string
  size: number
  textHash: string
  pages: Array<{ page?: number; text: string }>
}
export type SourceEvidenceReference = { documentId: string; page?: number; quote: string; documentName: string }
export type SourceExtractionDecision = {
  fieldKey: string
  value: string | number | boolean | null
  status: "found" | "ambiguous" | "not_found"
  evidence: Array<{ documentId: string; page?: number | null; quote: string }>
}
export type ExtractableSourceField = {
  fieldKey: string
  label: string
  section: string
  controlType: string
  required: boolean
  options: Field["options"]
}
export type SourcePrepareFieldResult = {
  fieldKey: string
  status: "filled" | "preserved" | "conflict" | "ambiguous" | "invalid" | "not_found" | "stale"
  extractedValue?: SourceExtractionDecision["value"]
  normalizedValue?: Value
  evidence?: SourceEvidenceReference[]
  reviewState?: "ai_filled" | "user_edited"
}
export type SourceFillSnapshot = {
  fieldKey: string
  field: Field
  previousValue: Value
  appliedValue: Value
  undone?: boolean
}
export type SourcePrepareSummary = {
  filled: number; preserved: number; conflicts: number; ambiguous: number; invalid: number; notFound: number; stale: number
}
export type SourcePrepareView = {
  sessionId: string
  tabId: number
  status: "idle" | "extracting" | "filling" | "review" | "completed" | "failed"
  summary: SourcePrepareSummary
  documentNames: string[]
  canUndo: boolean
  undoSummary?: { restored: number; preserved: number; stale: number }
}
export type SourcePrepareSession = {
  id: string
  tabId: number
  transferId: string
  sourcePageIdentity: string
  sourceFingerprint: string
  selectedModelId: string
  observation: Observation
  documents: ParsedDocument[]
  fields: Array<{ fieldKey: string; field: Field }>
  results: SourcePrepareFieldResult[]
  snapshots: SourceFillSnapshot[]
  status: SourcePrepareView["status"]
  createdAt: number
  undoSummary?: SourcePrepareView["undoSummary"]
}
export type SourceReviewMark = {
  pageIdentity: string
  sourceFingerprint: string
  sessionId: string
  fieldKey: string
  fieldId: string
  status: "filled" | "conflict"
  evidence: SourceEvidenceReference[]
  appliedValue: Value
}
