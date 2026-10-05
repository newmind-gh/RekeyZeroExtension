import { resolveSourceExtraction } from "./placeholder-resolver"
import { guardedPageRequest } from "../../transfer/guarded-page-client"
import { transferCommand } from "../../transfer/controller"
import type { Action, Field, Observation, Plan, Session } from "../../transfer/types"
import type { PersonalModelProvider } from "../ai/model-provider"
import { validatePreparedDocuments } from "./document-converter"
import { extractSourceFields } from "./source-extractor"
import { validateSourceExtraction } from "./source-prepare-validator"
import { isBlankSourceValue, normalizeSourceValue } from "./source-value-normalizer"
import { allSourcePrepareSessions, deleteSourcePrepare, loadSourcePrepare, saveSourcePrepare, sourcePrepareView, PREPARE_DRAFT_PREFIX, LEGACY_PREPARE_DRAFT_PREFIX } from "./source-prepare-store"
import type { PreparedDocument, SourcePrepareFieldResult, SourcePrepareSession, SourcePrepareView } from "./source-prepare-session"
import { PRIVACY_PROCESSING_ERROR } from "./privacy-processor"

const active = new Map<number, AbortController>()
const undoing = new Set<number>()
const samePage = (before: Observation, after: Observation) => before.epoch === after.epoch && before.identity === after.identity
  && before.template === after.template && before.structure === after.structure && !after.blockedReason
function currentField(before: Field, observation: Observation): Field | undefined {
  const fields = observation.fields.filter((field) => field.id === before.id && field.instanceKey === before.instanceKey && field.instanceStable
    && !field.ambiguousInObservation && field.writable && field.type === before.type && field.label === before.label && field.group === before.group
    && JSON.stringify(field.options.map(({ value, label }) => [value, label])) === JSON.stringify(before.options.map(({ value, label }) => [value, label])))
  return fields.length === 1 ? fields[0] : undefined
}
function actionPlan(observation: Observation, field: Field, expected: Action["expected"]): Plan {
  return { id: crypto.randomUUID(), version: 1, snapshotHash: "source-prepare", epoch: observation.epoch,
    identity: observation.identity, template: observation.template, structure: observation.structure, selectedGroups: observation.selectedGroups,
    actions: [{ id: crypto.randomUUID(), field, expected, before: field.value, status: "ready", reason: "Source preparation" }] }
}
async function observe(session: SourcePrepareSession): Promise<Observation> {
  const reply = await guardedPageRequest(session.transferId, session.tabId, "source-prepare", "observe", { selectedGroups: session.observation.selectedGroups })
  if (!reply.observation) throw new Error("Source page observation is unavailable")
  return reply.observation
}
async function assertLive(session: SourcePrepareSession, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error("Source preparation was cancelled")
  const current = await transferCommand({ type: "GET_TRANSFER" }) as Session
  if (current.id !== session.transferId || current.sourceTabId !== session.tabId || current.frozen
    || (await loadSourcePrepare(session.tabId))?.id !== session.id) throw new Error("The source page changed while extraction was running. Run Prepare Source again.")
}
async function annotate(session: SourcePrepareSession, result: SourcePrepareFieldResult, field: Field): Promise<void> {
  const reply = await guardedPageRequest(session.transferId, session.tabId, "source-prepare", "annotate_source", {
    documentEpoch: session.observation.epoch, selectedGroups: session.observation.selectedGroups,
    sourceReview: { pageIdentity: session.sourcePageIdentity, sourceFingerprint: session.sourceFingerprint,
      sessionId: session.id, fieldKey: result.fieldKey, fieldId: field.id,
      status: result.status === "conflict" ? "conflict" : "filled", evidence: result.evidence ?? [], appliedValue: field.value },
  }).catch(() => undefined)
  result.annotationStatus = reply?.sourceAnnotationShown ? "shown" : "unavailable"
}
export function safePrepareError(error: unknown): string {
  const message = error instanceof Error ? error.message : ""
  // Never return an arbitrary provider/DOM error containing source values or raw output.
  if (/^(Gemini|OpenAI|Claude|DeepSeek) (rejected the API key|rate limit was reached|returned HTTP \d+)$/.test(message)) return message
  if (new Set([
    PRIVACY_PROCESSING_ERROR, "This document could not be converted to text.", "Unsupported document format.",
    "Add between 1 and 6 source documents", "Could not read this document", "No readable text was found in this document",
    "These documents are too large for Source Preparation (80,000 characters maximum)", "Source page observation is unavailable",
    "Source preparation was cancelled", "The source page changed while extraction was running. Run Prepare Source again.",
    "No supported values can be filled: the source page has no blank editable fields", "Select and observe a source page before preparing it",
    "Select a readable source form before preparing it", "Select an active Source Preparation session",
    "Allow this website before reading or filling", "Allow this website before using its AI provider",
    "Start a new batch before preparing the source page", "This model does not support document extraction. Choose another AI model.",
    "AI returned invalid extraction JSON twice", "AI returned an invalid extraction result", "Prepare Source is already running",
  ]).has(message) || /^Select and configure (Gemini|OpenAI|Claude|DeepSeek) before preparing the source$/.test(message)) return message
  return "Source preparation could not complete. Check the selected AI provider and source page, then try again."
}
export async function getSourcePrepare(tabId: number): Promise<SourcePrepareView | null> {
  const session = await loadSourcePrepare(tabId)
  if (!session) return null
  if (["extracting", "filling"].includes(session.status) && !active.has(tabId)) { session.status = "failed"; await saveSourcePrepare(session) }
  return sourcePrepareView(session)
}
export async function prepareSource(documents: PreparedDocument[], modelId: string, provider: PersonalModelProvider): Promise<SourcePrepareView> {
  validatePreparedDocuments(documents)
  const transfer = await transferCommand({ type: "GET_TRANSFER" }) as Session
  if (!transfer.source || transfer.sourceTabId === undefined) throw new Error("Select and observe a source page before preparing it")
  if (transfer.frozen) throw new Error("Start a new batch before preparing the source page")
  const tabId = transfer.sourceTabId
  if (active.has(tabId) || undoing.has(tabId)) throw new Error("Prepare Source is already running")
  const controller = new AbortController()
  active.set(tabId, controller)
  const timer = setTimeout(() => controller.abort(), 120_000)
  let session: SourcePrepareSession | undefined
  try {
    const reply = await guardedPageRequest(transfer.id, tabId, "source-prepare", "observe", { selectedGroups: transfer.source.selectedGroups })
    const observation = reply.observation
    if (!observation || observation.blockedReason) throw new Error("Select a readable source form before preparing it")
    const eligible = observation.fields.filter((field) => field.writable && field.instanceStable && !field.ambiguousInObservation)
    const blanks = eligible.filter((field) => isBlankSourceValue(field.value))
    if (!blanks.length) throw new Error("No supported values can be filled: the source page has no blank editable fields")
    const previous = await loadSourcePrepare(tabId)
    if (previous) await guardedPageRequest(previous.transferId, tabId, "source-prepare", "clear_source_annotations", { sourcePrepareSessionId: previous.id }).catch(() => undefined)
    session = { id: crypto.randomUUID(), tabId, transferId: transfer.id, sourcePageIdentity: observation.pageIdentity,
      sourceFingerprint: observation.structure, selectedModelId: modelId, observation, documents,
      fields: blanks.map((field, index) => ({ fieldKey: `field_${String(index + 1).padStart(3, "0")}`, field })),
      results: [],
      snapshots: previous && samePage(previous.observation, observation) ? previous.snapshots.filter((snapshot) => !snapshot.undone) : [],
      status: "extracting", createdAt: Date.now() }
    if (controller.signal.aborted) throw new Error("Source preparation was cancelled")
    const liveTransfer = await transferCommand({ type: "GET_TRANSFER" }) as Session
    if (liveTransfer.id !== transfer.id || liveTransfer.sourceTabId !== tabId || liveTransfer.frozen) throw new Error("The source page changed while extraction was running. Run Prepare Source again.")
    await saveSourcePrepare(session)
    const output = await extractSourceFields(provider, session.fields.map(({ fieldKey, field }) => ({
      fieldKey, label: field.label, section: field.group, controlType: field.type, required: field.required, options: field.options,
    })), documents, controller.signal)
    await assertLive(session, controller.signal)
    const results = resolveSourceExtraction(validateSourceExtraction(output, session.fields, documents), documents)
    const actionable = new Set(results.filter((result) => result.status === "filled"))
    for (const result of actionable) result.status = "invalid"
    session.results.push(...results)
    session.status = "filling"
    await saveSourcePrepare(session)
    const fresh = await observe(session)
    if (!samePage(observation, fresh)) {
      for (const result of actionable) result.status = "stale"
      session.status = "failed"; await saveSourcePrepare(session)
      throw new Error("The source page changed while extraction was running. Run Prepare Source again.")
    }
    for (const result of results) {
      await assertLive(session, controller.signal)
      if (!actionable.has(result)) continue
      const before = session.fields.find((item) => item.fieldKey === result.fieldKey)!.field
      const current = await observe(session)
      const field = samePage(observation, current) ? currentField(before, current) : undefined
      if (!field) { result.status = "stale"; continue }
      const normalized = normalizeSourceValue(result.resolvedValue, field)
      if (!isBlankSourceValue(field.value)) {
        result.status = normalized !== undefined && !Object.is(normalized, field.value) ? "conflict" : "preserved"
        if (result.status === "conflict") await annotate(session, result, field)
        continue
      }
      if (normalized === undefined) { result.status = "invalid"; continue }
      result.normalizedValue = normalized
      if (Object.is(normalized, field.value)) { result.status = "preserved"; continue }
      const plan = actionPlan(current, field, normalized)
      const filled = (await guardedPageRequest(session.transferId, tabId, "source-prepare", "apply", {
        plan, actionId: plan.actions[0].id, documentEpoch: current.epoch, blankOnly: true,
      })).action
      if (filled?.status === "filled_verified") {
        await assertLive(session, controller.signal)
        session.snapshots.push({ fieldKey: result.fieldKey, field, previousValue: field.value, appliedValue: normalized })
        result.status = "filled"
        await saveSourcePrepare(session)
        await annotate(session, result, { ...field, value: normalized })
      } else result.status = filled?.status === "preserved_existing" ? "preserved" : filled?.status === "stale" ? "stale" : "invalid"
    }
    await assertLive(session, controller.signal)
    session.status = "prepared"
    await saveSourcePrepare(session)
    // Refresh the canonical page snapshot; profiles never see documents or results.
    await transferCommand({ type: "SET_SOURCE", tabId, group: transfer.source.group }).catch(() => undefined)
    return sourcePrepareView(session)
  } catch (error) {
    if (session && (await loadSourcePrepare(tabId))?.id === session.id) { session.status = "failed"; await saveSourcePrepare(session) }
    throw new Error(safePrepareError(error))
  } finally { clearTimeout(timer); if (active.get(tabId) === controller) active.delete(tabId) }
}
async function sessionById(sessionId: string): Promise<SourcePrepareSession> {
  const session = (await allSourcePrepareSessions()).find((item) => item.id === sessionId)
  if (!session) throw new Error("Select an active Source Preparation session")
  return session
}
export async function undoSourcePrepare(sessionId: string): Promise<SourcePrepareView> {
  const session = await sessionById(sessionId)
  if (active.has(session.tabId) || undoing.has(session.tabId)) throw new Error("Prepare Source is already running")
  undoing.add(session.tabId)
  const controller = new AbortController()
  active.set(session.tabId, controller)
  session.undoSummary = { restored: 0, preserved: 0, stale: 0 }
  try {
    await guardedPageRequest(session.transferId, session.tabId, "source-prepare", "clear_source_annotations", { sourcePrepareSessionId: session.id }).catch(() => undefined)
    for (const snapshot of [...session.snapshots].reverse()) {
      if (snapshot.undone) continue
      await assertLive(session, controller.signal)
      const current = await observe(session)
      const field = samePage(session.observation, current) ? currentField(snapshot.field, current) : undefined
      if (!field) { session.undoSummary.stale++; continue }
      if (!Object.is(field.value, snapshot.appliedValue)) { session.undoSummary.preserved++; continue }
      const plan = actionPlan(current, field, snapshot.previousValue)
      const action = (await guardedPageRequest(session.transferId, session.tabId, "source-prepare", "apply", {
        plan, actionId: plan.actions[0].id, documentEpoch: current.epoch, requireExactValue: true,
      })).action
      if (action?.status === "filled_verified" || action?.status === "already_equal") { snapshot.undone = true; session.undoSummary.restored++ }
      else if (action?.status === "preserved_existing") session.undoSummary.preserved++
      else session.undoSummary.stale++
      if ((await loadSourcePrepare(session.tabId))?.id === session.id) await saveSourcePrepare(session)
    }
    session.status = "undone"
    await assertLive(session, controller.signal)
    await saveSourcePrepare(session)
    await guardedPageRequest(session.transferId, session.tabId, "source-prepare", "clear_source_annotations", { sourcePrepareSessionId: session.id }).catch(() => undefined)
    const transfer = await transferCommand({ type: "GET_TRANSFER" }) as Session
    if (!transfer.frozen && transfer.sourceTabId === session.tabId) await transferCommand({ type: "SET_SOURCE", tabId: session.tabId, group: transfer.source?.group }).catch(() => undefined)
    return sourcePrepareView(session)
  } finally { undoing.delete(session.tabId); if (active.get(session.tabId) === controller) active.delete(session.tabId) }
}
export async function clearSourcePrepare(sessionId?: string, tabId?: number): Promise<void> {
  if (!sessionId) for (const [id, controller] of active) if (tabId === undefined || tabId === id) controller.abort()
  const sessions = (await allSourcePrepareSessions()).filter((session) => (!sessionId || session.id === sessionId) && (tabId === undefined || session.tabId === tabId))
  for (const session of sessions) {
    active.get(session.tabId)?.abort()
    await deleteSourcePrepare(session.tabId)
    await chrome.tabs.sendMessage(session.tabId, { type: "TRANSFER_PAGE", operation: "clear_source_annotations",
      transferId: session.transferId, targetId: "source-prepare", tabId: session.tabId, documentEpoch: "",
      requestId: crypto.randomUUID(), sourcePrepareSessionId: session.id }, { frameId: 0 }).catch(() => undefined)
  }
  if (tabId !== undefined) {
    await chrome.storage.session.remove(`${PREPARE_DRAFT_PREFIX}${tabId}`)
    await chrome.storage.session.remove(`${LEGACY_PREPARE_DRAFT_PREFIX}${tabId}`)
  }
  else if (!sessionId) {
    const saved = await chrome.storage.session.get(null)
    for (const key of Object.keys(saved)) if (key.startsWith(LEGACY_PREPARE_DRAFT_PREFIX)) await chrome.storage.session.remove(key)
  }
}
export async function showSourcePrepareEvidence(sessionId: string, visible: boolean): Promise<void> {
  const session = await sessionById(sessionId)
  await guardedPageRequest(session.transferId, session.tabId, "source-prepare", "toggle_source_evidence", {
    documentEpoch: session.observation.epoch, sourcePrepareSessionId: session.id, evidenceVisible: visible,
  })
}
