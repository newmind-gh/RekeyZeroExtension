import { describe, expect, it } from "vitest"
import { driftReport, hasBaselineOverlap } from "./profile-drift"
import { planTransfer } from "./planner"
import type { Field, Observation, ProfilePageTemplate, Snapshot } from "./types"

const field = (templateKey: string, patch: Partial<Field> = {}): Field => ({
  id: templateKey, instanceKey: templateKey, templateKey, identityKey: templateKey, label: templateKey,
  type: "text", group: "", value: "", display: "", required: false, options: [],
  writable: true, reusable: true, templateStable: true, instanceStable: true, ambiguousInObservation: false, ...patch,
})
const observation = (fields: Field[]): Observation => ({
  epoch: "epoch", identity: "identity", pageIdentity: "identity", identityEvidence: [], identityConfidence: "new_form",
  origin: "https://example.test", title: "Fixture", template: "changed", structure: "structure", fields,
  scannedCount: fields.length, eligibleCount: fields.length, truncated: false,
})
const baseline: ProfilePageTemplate = {
  origin: "https://example.test", pathPattern: "/:segment", title: "Fixture", template: "old",
  fields: ["stable", "missing", "changed", "ambiguous"].map((key) => ({ templateKey: key, identityKey: key, type: "text", label: key })),
}

describe("Profile drift safety", () => {
  it("separates compatible, missing, type-changed, ambiguous, and new fields", () => {
    const report = driftReport(baseline, observation([
      field("stable"), field("changed-new-key", { identityKey: "changed", type: "email" }),
      field("ambiguous"), field("ambiguous", { instanceKey: "second" }), field("new"),
    ]), ["stable", "missing", "changed", "ambiguous"], "target")
    expect(report.unchangedMappedFields).toEqual(["stable"])
    expect(report.missingMappedFields).toEqual(["missing"])
    expect(report.changedControlTypes).toEqual(["changed"])
    expect(report.ambiguousFields).toEqual(["ambiguous"])
    expect(report.newFields).toEqual(["new"])
    expect(report.blockedKeys).toEqual(["missing", "changed", "ambiguous"])
  })

  it("requires a baseline and overlap and refuses blocked or truncated observations", () => {
    expect(hasBaselineOverlap(baseline, observation([field("stable")]))).toBe(true)
    expect(hasBaselineOverlap({ ...baseline, fields: undefined }, observation([field("stable")]))).toBe(false)
    expect(hasBaselineOverlap(baseline, observation([field("unrelated")]))).toBe(false)
    expect(hasBaselineOverlap(baseline, { ...observation([field("stable")]), truncated: true })).toBe(false)
    expect(hasBaselineOverlap(baseline, { ...observation([field("stable")]), blockedReason: "unsafe" })).toBe(false)
  })

  it("never falls back to same-label mappings for a new or failed Profile mapping", () => {
    const source = { ...observation([field("source", { label: "Same label", value: "PRIVATE" })]), id: "source", hash: "hash", capturedAt: "now", group: "", availableGroups: [] } as Snapshot
    const target = observation([field("target", { label: "Same label" })])
    expect(planTransfer(source, target, {}, 0, true).actions[0].status).toBe("unmapped")
    expect(planTransfer(source, target, { target: { blockReason: "Missing mapped source" } }, 0, true).actions[0].status).toBe("unmapped")
    expect(planTransfer(source, target, { target: { sourceInstanceKey: "source" } }, 0, true).actions[0].status).toBe("ready")
  })
})
