export type Value = string | boolean | null
export type Field = {
  id: string
  templateKey: string
  identityKey?: string
  instanceKey: string
  templateStable: boolean
  instanceStable: boolean
  ambiguousInObservation: boolean
  label: string
  group: string
  type: string
  semanticType?: import("./control-adapters").SemanticControlType
  adapterId?: string
  scope?: string
  value: Value
  display: string
  options: { value: string; label: string }[]
  required: boolean
  writable: boolean
  reusable: boolean
}
export type Observation = {
  epoch: string
  identity: string
  pageIdentity: string
  identityEvidence: { kind: string; label: string; value: string; confidence: "high" | "medium" }[]
  identityConfidence: "high" | "medium" | "new_form" | "uncertain"
  template: string
  structure: string
  origin: string
  title: string
  fields: Field[]
  groups?: { name: string; count: number }[]
  selectedGroups?: string[]
  scannedCount: number
  eligibleCount: number
  truncated: boolean
  blockedReason?: string
  recordValues?: Record<string, Value>
}
export type Snapshot = Observation & { id: string; hash: string; capturedAt: string; group: string; availableGroups: string[] }
export type FieldStatus = "ready" | "filled_verified" | "already_equal" | "preserved_existing" |
  "unmapped" | "source_missing" | "unsupported" | "validation_failed" | "stale" | "cancelled" | "unknown" | "skipped"
export type Decision = { blockReason?: string; sourceInstanceKey?: string; mode?: "overwrite" | "preserve" | "skip"; before?: Value; option?: string }
export type Action = {
  id: string
  field: Field
  sourceInstanceKey?: string
  expected: Value
  before: Value
  status: FieldStatus
  reason: string
  observed?: Value
}
export type Plan = {
  id: string
  version: number
  selectedGroups?: string[]
  snapshotHash: string
  epoch: string
  identity: string
  template: string
  structure: string
  actions: Action[]
  recordValues?: Record<string, Value>
}
export type Target = {
  id: string
  tabId: number
  windowId: number
  origin: string
  title: string
  status: string
  error?: string
  observation?: Observation
  plan?: Plan
  decisions: Record<string, Decision>
  confirmedIdentity?: string
}
export type ProfileFieldTemplate = { templateKey: string; identityKey?: string; type: string; label: string }
export type ProfilePageTemplate = {
  selectedGroups?: string[]
  origin: string
  pathPattern: string
  fields?: ProfileFieldTemplate[]
  template: string
  title: string
}
export type ProfileFieldMapping = {
  sourceTemplateKey: string
  targetTemplateKey: string
  existingValuePolicy: "blank_only" | "overwrite" | "skip"
}
export type ProfileTargetTemplate = ProfilePageTemplate & {
  id: string
  mappings: ProfileFieldMapping[]
}
export type MappingProfile = {
  id: string
  name: string
  kind?: "profile" | "ai_fill_setup"
  version: 1 | 2
  revision?: number
  source: ProfilePageTemplate
  targets: ProfileTargetTemplate[]
  createdAt: string
  updatedAt: string
}
export type ProfileDriftReport = {
  page: "source" | "target"
  targetId?: string
  title: string
  unchangedMappedFields: string[]
  missingMappedFields: string[]
  newFields: string[]
  changedControlTypes: string[]
  ambiguousFields: string[]
  blockedKeys: string[]
}
export type Session = {
  id: string
  revision: number
  status: string
  sourceTabId?: number
  source?: Snapshot
  frozen: boolean
  sourceChanged?: boolean
  mappingProfileId?: string
  profileDrift?: { reviewed: boolean; reports: ProfileDriftReport[] }
  confirmedSourceIdentity?: string
  panelActive?: boolean
  targets: Target[]
  error?: string
}
export type Command =
  | { type: "GET_TRANSFER" | "RESET_TRANSFER" | "RUN_TRANSFER" | "CANCEL_TRANSFER" }
  | { type: "SET_SOURCE"; tabId: number; group?: string }
  | { type: "SET_TRANSFER_ACTIVE"; active: boolean }
  | { type: "ADD_TARGETS"; tabIds: number[] }
  | { type: "SET_TARGET_GROUPS"; targetId: string; groups: string[] }
  | { type: "REMOVE_TARGET" | "RESUME_TARGET"; targetId: string }
  | { type: "CONFIRM_TARGET_IDENTITY"; targetId: string }
  | { type: "CONFIRM_SOURCE_IDENTITY" }
  | { type: "APPROVE_PROFILE_DRIFT" }
  | { type: "GET_MAPPING_PROFILES" }
  | { type: "USE_MAPPING_PROFILE" | "OPEN_MAPPING_PROFILE"; profileId: string }
  | { type: "DELETE_MAPPING_PROFILE"; profileId: string }
  | { type: "APPLY_AI_FIELD_MATCHES"; targets: { targetId: string; mappings: { targetInstanceKey: string; sourceInstanceKey: string }[] }[] }
  | { type: "SAVE_MAPPING_PROFILE"; profileId?: string; kind?: "profile" | "ai_fill_setup"; name: string; targets: { targetId: string; mappings: { targetInstanceKey: string; sourceInstanceKey?: string; existingValuePolicy: "blank_only" | "overwrite" | "skip" }[] }[] }
export type Envelope = { transferId: string; targetId: string; tabId: number; documentEpoch: string; requestId: string }
export type PageCommand = Envelope & {
  type: "TRANSFER_PAGE"
  operation: "observe" | "apply" | "read" | "annotate_source" | "clear_source_annotations" | "toggle_source_evidence"
  blankOnly?: boolean
  requireExactValue?: boolean
  sourceReview?: import("../personal/source-prepare/source-prepare-session").SourceReviewMark
  sourcePrepareSessionId?: string
  evidenceVisible?: boolean
  plan?: Plan
  selectedGroups?: string[]
  actionId?: string
}
export type PageReply = { ok: boolean; error?: string; envelope: Envelope; observation?: Observation; action?: Action; sourceAnnotationShown?: boolean }
