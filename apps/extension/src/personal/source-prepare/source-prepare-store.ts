import type { SourcePrepareSession, SourcePrepareSummary, SourcePrepareView } from "./source-prepare-session"
import type { PreparedDocument } from "./source-prepare-session"
import { validatePreparedDocuments } from "./document-converter"
import { PRIVACY_PROCESSING_ERROR } from "./privacy-processor"

export const SOURCE_PREPARE_PREFIX = "rekeyzeroSourcePrepare:"
export const LEGACY_PREPARE_DRAFT_PREFIX = "rekeyzeroSourcePrepareDraft:"
// Old, deterministic-only drafts cannot cross the v2 provider boundary.
export const PREPARE_DRAFT_PREFIX = `${LEGACY_PREPARE_DRAFT_PREFIX}v2:`
export async function sourceDocumentsForExtraction(tabId: number, documentIds: string[]): Promise<PreparedDocument[]> {
  if (!Array.isArray(documentIds) || !documentIds.length || documentIds.length > 6 || new Set(documentIds).size !== documentIds.length) throw new Error("Add between 1 and 6 source documents")
  // Accept only IDs from the message. Content comes from the trusted local
  // preparation draft, never caller-supplied raw Markdown or privacy claims.
  const key = `${PREPARE_DRAFT_PREFIX}${tabId}`
  const saved: unknown = (await chrome.storage.session.get(key))[key]
  validatePreparedDocuments(saved)
  const selected = documentIds.map((id) => saved.find((document) => document.id === id))
  if (selected.some((document) => !document)) throw new Error(PRIVACY_PROCESSING_ERROR)
  validatePreparedDocuments(selected)
  return selected
}
export async function saveSourcePrepare(session: SourcePrepareSession): Promise<void> {
  await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  await chrome.storage.session.set({ [`${SOURCE_PREPARE_PREFIX}${session.tabId}`]: session })
}
export async function loadSourcePrepare(tabId: number): Promise<SourcePrepareSession | null> {
  const key = `${SOURCE_PREPARE_PREFIX}${tabId}`
  const saved = (await chrome.storage.session.get(key))[key]
  return saved && typeof saved === "object" && (saved as SourcePrepareSession).tabId === tabId ? saved as SourcePrepareSession : null
}
export async function deleteSourcePrepare(tabId: number): Promise<void> {
  await chrome.storage.session.remove(`${SOURCE_PREPARE_PREFIX}${tabId}`)
}
export async function allSourcePrepareSessions(): Promise<SourcePrepareSession[]> {
  const saved = await chrome.storage.session.get(null)
  return Object.entries(saved).filter(([key]) => key.startsWith(SOURCE_PREPARE_PREFIX)).map(([, value]) => value as SourcePrepareSession)
}
export function sourcePrepareView(session: SourcePrepareSession): SourcePrepareView {
  const summary: SourcePrepareSummary = { filled: 0, preserved: 0, conflicts: 0, ambiguous: 0, invalid: 0, notFound: 0, stale: 0 }
  const names = { filled: "filled", preserved: "preserved", conflict: "conflicts", ambiguous: "ambiguous", invalid: "invalid", not_found: "notFound", stale: "stale" } as const
  for (const result of session.results) summary[names[result.status]]++
  return { sessionId: session.id, tabId: session.tabId, status: session.status, summary,
    documentNames: session.documents.map((document) => document.name), canUndo: session.snapshots.some((snapshot) => !snapshot.undone),
    annotationsFailed: session.results.filter((result) => result.annotationStatus === "unavailable").length,
    ...(session.undoSummary ? { undoSummary: session.undoSummary } : {}) }
}
