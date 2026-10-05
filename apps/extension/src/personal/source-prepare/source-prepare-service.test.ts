import { beforeEach, describe, expect, it, vi } from "vitest"
import { transferCommand } from "../../transfer/controller"
import { guardedPageRequest } from "../../transfer/guarded-page-client"
import type { Field, Observation, PageCommand, Session, Snapshot } from "../../transfer/types"
import type { PersonalModelProvider, ModelRequest } from "../ai/model-provider"
import { prepareSource, undoSourcePrepare, clearSourcePrepare, safePrepareError, sourcePrepareEdited } from "./source-prepare-service"
import { loadSourcePrepare } from "./source-prepare-store"
import type { ParsedDocument } from "./source-prepare-session"

vi.mock("../../transfer/controller", () => ({ transferCommand: vi.fn() }))
vi.mock("../../transfer/guarded-page-client", () => ({ guardedPageRequest: vi.fn() }))
const values: Record<string, unknown> = {}
let observation: Observation
let transfer: Session
const document: ParsedDocument = { id: "doc-1", name: "evidence.txt", mediaType: "text/plain", size: 100,
  textHash: "a".repeat(64), pages: [{ text: "Organisation: Example Pty Ltd\nState: NSW\nTurnover: $12.5m\nPRIVATE_DOCUMENT_447" }] }
function field(id: string, label: string, value = "", type = "text"): Field {
  return { id, label, value, type, display: value, group: "Organisation", options: type === "select" ? [{ value: "", label: "Choose" }, { value: "NSW", label: "NSW" }, { value: "VIC", label: "VIC" }] : [],
    templateKey: id, instanceKey: id, templateStable: true, instanceStable: true, ambiguousInObservation: false, writable: true, required: false, reusable: true }
}
function provider(decisions?: unknown[], during?: () => Promise<void> | void): PersonalModelProvider {
  return { id: "fixture-provider", kind: "external_api", health: async () => ({ status: "ready" }),
    completeJson: vi.fn(async (request: ModelRequest) => {
      expect(JSON.stringify(request.input)).not.toContain("PRIVATE_EXISTING_991")
      expect(JSON.stringify(request.input)).toContain("PRIVATE_DOCUMENT_447")
      expect(JSON.stringify(request.input)).not.toContain('"fieldKey":"existing"')
      await during?.()
      return { providerId: "fixture-provider", modelId: "fixture-model", rawResponses: ["PRIVATE_RAW_OUTPUT_667"], output: { decisions: decisions ?? [
        { fieldKey: "field_001", status: "found", value: "Example Pty Ltd", evidence: [{ documentId: "doc-1", quote: "Organisation: Example Pty Ltd" }] },
        { fieldKey: "field_002", status: "found", value: "$12.5m", evidence: [{ documentId: "doc-1", quote: "Turnover: $12.5m" }] },
        { fieldKey: "field_003", status: "found", value: "New South Wales", evidence: [{ documentId: "doc-1", quote: "State: NSW" }] },
      ] } } as never
    }) }
}
beforeEach(() => {
  vi.clearAllMocks()
  for (const key of Object.keys(values)) delete values[key]
  observation = { epoch: "epoch", identity: "identity", pageIdentity: "identity", identityEvidence: [], identityConfidence: "new_form",
    template: "template", structure: "structure", origin: "https://source.example", title: "Source form",
    fields: [field("name", "Organisation"), field("turnover", "Turnover", "", "number"), field("state", "State", "", "select"), field("existing", "Existing reference", "PRIVATE_EXISTING_991")],
    scannedCount: 4, eligibleCount: 4, truncated: false }
  transfer = { id: "transfer", revision: 0, status: "draft", frozen: false, sourceTabId: 7, source: { ...observation, group: "" } as Snapshot, targets: [] }
  vi.stubGlobal("chrome", { storage: { session: {
    get: async (key: string | null) => key === null ? structuredClone(values) : { [key]: structuredClone(values[key]) },
    set: async (input: Record<string, unknown>) => Object.assign(values, structuredClone(input)),
    remove: async (key: string) => { delete values[key] }, setAccessLevel: async () => {},
  } }, tabs: { sendMessage: vi.fn().mockResolvedValue({ ok: true }) } })
  vi.mocked(transferCommand).mockImplementation(async () => transfer as never)
  vi.mocked(guardedPageRequest).mockImplementation(async (_transferId, _tabId, _targetId, operation, extra) => {
    if (operation === "observe") return { ok: true, observation: structuredClone(observation), envelope: {} } as never
    if (operation === "apply") {
      const action = extra!.plan!.actions[0]
      const target = observation.fields.find((field) => field.id === action.field.id)!
      if (extra?.blankOnly && target.value) return { ok: true, action: { ...action, status: "preserved_existing", observed: target.value } } as never
      target.value = action.expected
      return { ok: true, action: { ...action, status: "filled_verified", observed: action.expected } } as never
    }
    return { ok: true, envelope: {} } as never
  })
})
describe("blank-only source preparation", () => {
  it("extracts only blank fields, fills via the existing guarded page API, and stores session-only data", async () => {
    const model = provider()
    const result = await prepareSource([document], "shared-selected-model", model)
    expect(result.summary).toMatchObject({ filled: 3, preserved: 1, invalid: 0 })
    expect(observation.fields.map((field) => field.value)).toEqual(["Example Pty Ltd", "12500000", "NSW", "PRIVATE_EXISTING_991"])
    const calls = vi.mocked(guardedPageRequest).mock.calls.filter((call) => call[3] === "apply")
    expect(calls).toHaveLength(3)
    expect(calls.every((call) => call[4]?.blankOnly === true)).toBe(true)
    expect(vi.mocked(guardedPageRequest).mock.calls.filter((call) => call[3] === "observe").length).toBeGreaterThan(3)
    expect((await loadSourcePrepare(7))?.documents).toEqual([document])
    expect(JSON.stringify(values)).not.toContain("PRIVATE_RAW_OUTPUT_667")
    expect(result).not.toHaveProperty("results")
    expect(result).not.toHaveProperty("documents")
    expect(transferCommand).toHaveBeenLastCalledWith({ type: "SET_SOURCE", tabId: 7, group: "" })
  })
  it("preserves a field populated during extraction and marks conflicting evidence", async () => {
    const result = await prepareSource([document], "shared-model", provider(undefined, () => { observation.fields[0].value = "User's new organisation" }))
    expect(result.summary).toMatchObject({ filled: 2, preserved: 1, conflicts: 1 })
    expect(observation.fields[0].value).toBe("User's new organisation")
    expect(vi.mocked(guardedPageRequest).mock.calls.some((call) => call[3] === "annotate_source" && call[4]?.sourceReview?.status === "conflict")).toBe(true)
  })
  it("skips invalid, ambiguous, and not-found decisions", async () => {
    const result = await prepareSource([document], "shared-model", provider([
      { fieldKey: "field_001", status: "ambiguous", value: null, evidence: [] },
      { fieldKey: "field_002", status: "found", value: "lots of money", evidence: [{ documentId: "doc-1", quote: "Turnover: $12.5m" }] },
      { fieldKey: "field_003", status: "not_found", value: null, evidence: [] },
    ]))
    expect(result.summary).toMatchObject({ filled: 0, ambiguous: 1, invalid: 1, notFound: 1 })
    expect(vi.mocked(guardedPageRequest).mock.calls.some((call) => call[3] === "apply")).toBe(false)
  })
  it("rejects a replaced field or changed page before any write", async () => {
    await expect(prepareSource([document], "shared-model", provider(undefined, () => { observation.structure = "changed"; observation.fields[0].id = "replacement" }))).rejects.toThrow("source page changed")
    expect(vi.mocked(guardedPageRequest).mock.calls.some((call) => call[3] === "apply")).toBe(false)
    expect((await loadSourcePrepare(7))?.results.filter((result) => result.status === "filled")).toHaveLength(0)
  })
  it("does not count unfinished actions as filled after a partial failure", async () => {
    const original = vi.mocked(guardedPageRequest).getMockImplementation()!
    let writes = 0
    vi.mocked(guardedPageRequest).mockImplementation(async (...args) => {
      if (args[3] === "apply" && ++writes === 2) throw new Error("PRIVATE_DOCUMENT_447")
      return original(...args)
    })
    await expect(prepareSource([document], "shared-model", provider())).rejects.toThrow("Source preparation could not complete")
    const saved = await loadSourcePrepare(7)
    expect(saved?.results.filter((result) => result.status === "filled")).toHaveLength(1)
    expect(saved?.snapshots).toHaveLength(1)
    expect(saved?.status).toBe("failed")
  })
  it("undo restores untouched AI values and preserves user edits with an exact-value guard", async () => {
    const result = await prepareSource([document], "shared-model", provider())
    observation.fields[0].value = "User edited organisation"
    await sourcePrepareEdited(result.sessionId, "field_001", 7)
    expect((await loadSourcePrepare(7))?.results.find((result) => result.fieldKey === "field_001")?.reviewState).toBe("user_edited")
    const undone = await undoSourcePrepare(result.sessionId)
    expect(undone.undoSummary).toEqual({ restored: 2, preserved: 1, stale: 0 })
    expect(observation.fields.map((field) => field.value)).toEqual(["User edited organisation", "", "", "PRIVATE_EXISTING_991"])
    expect(vi.mocked(guardedPageRequest).mock.calls.filter((call) => call[3] === "apply" && call[4]?.requireExactValue)).toHaveLength(2)
  })
  it("does not undo through replaced controls or a new page", async () => {
    const result = await prepareSource([document], "shared-model", provider())
    observation.structure = "replacement"
    const undone = await undoSourcePrepare(result.sessionId)
    expect(undone.undoSummary).toEqual({ restored: 0, preserved: 0, stale: 3 })
  })
  it("resolves select controls after session storage changes object property order", async () => {
    const result = await prepareSource([document], "shared-model", provider())
    const saved = await loadSourcePrepare(7)
    for (const snapshot of saved!.snapshots) snapshot.field.options = snapshot.field.options.map(({ value, label }) => ({ label, value }))
    values[`rekeyzeroSourcePrepare:7`] = saved
    expect((await undoSourcePrepare(result.sessionId)).undoSummary).toEqual({ restored: 3, preserved: 0, stale: 0 })
    expect(observation.fields[2].value).toBe("")
  })
  it("clearing while extraction is in flight cancels writes and does not recreate session data", async () => {
    let finish!: () => void
    let extracting!: () => void
    const started = new Promise<void>((resolve) => { extracting = resolve })
    const pending = prepareSource([document], "shared-model", provider(undefined, async () => {
      extracting(); await new Promise<void>((resolve) => { finish = resolve })
    }))
    await started
    await clearSourcePrepare(undefined, 7)
    finish()
    await expect(pending).rejects.toThrow("cancelled")
    expect(await loadSourcePrepare(7)).toBeNull()
    expect(vi.mocked(guardedPageRequest).mock.calls.some((call) => call[3] === "apply")).toBe(false)
  })
  it("blocks simultaneous preparations, frozen transfers, and empty pages", async () => {
    transfer.frozen = true
    await expect(prepareSource([document], "shared-model", provider())).rejects.toThrow("new batch")
    transfer.frozen = false
    for (const field of observation.fields) field.value = "populated"
    await expect(prepareSource([document], "shared-model", provider())).rejects.toThrow("no blank editable fields")
  })
  it("redacts arbitrary extraction errors before they can reach runtime logs or exports", () => {
    expect(safePrepareError(new Error("PRIVATE_DOCUMENT_447 raw extraction"))).not.toContain("PRIVATE_DOCUMENT")
    expect(safePrepareError(new Error("Select PRIVATE_DOCUMENT_447"))).not.toContain("PRIVATE_DOCUMENT")
    expect(safePrepareError(new Error("Claude returned HTTP 429"))).toBe("Claude returned HTTP 429")
  })
})
