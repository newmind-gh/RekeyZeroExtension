import type { SourcePrepareSession, SourcePrepareSummary, SourcePrepareView } from "./source-prepare-session"

export const SOURCE_PREPARE_PREFIX = "rekeyzeroSourcePrepare:"
export const PREPARE_DRAFT_PREFIX = "rekeyzeroSourcePrepareDraft:"
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
    ...(session.undoSummary ? { undoSummary: session.undoSummary } : {}) }
}
