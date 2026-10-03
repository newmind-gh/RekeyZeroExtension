import type { Action, Decision, Field, Observation, Plan, Snapshot, Value } from "./types"

export function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")
}
function equivalentLabel(a: string, b: string): boolean {
  const left = normalize(a), right = normalize(b)
  return Boolean(left && right && left === right)
}
function optionValueTokens(value: string): string[] {
  return value.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu)?.map(normalize) ?? []
}
export function equal(a: Value, b: Value): boolean {
  return typeof a === typeof b && (typeof a === "string" && typeof b === "string"
    ? a.trim().replace(/\s+/g, " ") === b.trim().replace(/\s+/g, " ") : a === b)
}
export const successful = (status: string) => ["filled_verified", "already_equal"].includes(status)
export const settled = (status: string) => successful(status) || ["preserved_existing", "skipped"].includes(status)
export async function hash(value: unknown): Promise<string> {
  const canonical = JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical))
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")
}
export async function snapshot(observation: Observation, group = ""): Promise<Snapshot> {
  const selected = group ? observation.fields.filter((field) => field.group === group) : observation.fields
  const counts = new Map<string, number>()
  selected.forEach((field) => counts.set(field.templateKey, (counts.get(field.templateKey) ?? 0) + 1))
  const fields = selected.map((field) => ({
    ...field,
    reusable: field.templateStable && field.instanceStable && counts.get(field.templateKey) === 1,
  }))
  return { ...observation, fields, group, id: crypto.randomUUID(), capturedAt: new Date().toISOString(),
    availableGroups: observation.groups?.map((group) => group.name).filter(Boolean) ?? [...new Set(observation.fields.map((f) => f.group))].filter(Boolean),
    hash: await hash({ identity: observation.identity, template: observation.template, fields, group }) }
}
function convert(source: Field, target: Field, decision?: Decision): Value | undefined {
  if (source.value === null || source.value === "") return undefined
  if ((target.semanticType === "boolean" || target.type === "checkbox")) return typeof source.value === "boolean" ? source.value : undefined
  if (typeof source.value === "boolean") return undefined
  if (target.options.length) {
    if (decision?.option !== undefined) return target.options.find((o) => o.value === decision.option)?.value
    const sourceValue = normalize(source.value)
    const matches = target.options.filter((option) => equal(option.value, source.value) ||
      normalize(option.label) === normalize(source.display) || optionValueTokens(option.value).includes(sourceValue))
    return matches.length === 1 ? matches[0].value : undefined
  }
  if (target.type === "date" && (source.type !== "date" || !/^\d{4}-\d{2}-\d{2}$/.test(source.value))) return undefined
  if (target.type === "number" && !/^-?\d+(\.\d+)?$/.test(source.value)) return undefined
  if (["date", "number"].includes(source.type) && target.type !== source.type && target.type !== "text") return undefined
  return source.value.trim()
}
export function planTransfer(source: Snapshot, target: Observation, decisions: Record<string, Decision>, version: number, profileOnly = false): Plan {
  const actions: Action[] = target.fields.map((field) => {
    const decision = decisions[field.instanceKey]
    const labelCandidates = source.fields.filter((s) => equivalentLabel(s.label, field.label))
    const groupedCandidates = labelCandidates.filter((s) => normalize(s.group) === normalize(field.group))
    const candidates = groupedCandidates.length === 1 ? groupedCandidates : labelCandidates
    const unambiguousTarget = target.fields.filter((f) => equivalentLabel(f.label, field.label)).length === 1
    const candidate = decision?.sourceInstanceKey ? source.fields.find((s) => s.instanceKey === decision.sourceInstanceKey) :
      !profileOnly && candidates.length === 1 && field.reusable && candidates[0].reusable && unambiguousTarget ? candidates[0] : undefined
    const action: Action = { id: crypto.randomUUID(), field, before: field.value, expected: null,
      sourceInstanceKey: candidate?.instanceKey,
      status: "unmapped", reason: "Choose a source field" }
    if (profileOnly && !decision) return { ...action, status: "unmapped", reason: "Field is not mapped in this profile" }
    if (decision?.blockReason) return { ...action, status: "unmapped", reason: decision.blockReason }
    if (decision?.mode === "skip") return { ...action, status: "skipped", reason: "Skipped for this batch" }
    if (decision?.mode === "preserve") return { ...action, status: "preserved_existing", reason: "Keep current value" }
    if (!field.instanceStable) return { ...action, status: "unsupported", reason: "Repeated target field has no stable instance identity" }
    if (!field.writable) return { ...action, status: "unsupported", reason: "Read-only, disabled or unsupported control" }
    if (field.type === "combobox" && field.options.length === 0) {
      return { ...action, status: "unsupported", reason: "No accepted options are currently available; fill prerequisite fields first" }
    }
    if (!candidate) return action
    if (candidate.value === null || candidate.value === "") return { ...action, status: "source_missing", reason: "Source value is empty" }
    const expected = convert(candidate, field, decision)
    if (expected === undefined) return { ...action, status: "unsupported", reason: "Choose an accepted option or compatible source format" }
    action.expected = expected
    if (equal(field.value, expected)) return { ...action, status: "ready", reason: "Already matches; ready for read-back verification" }
    const empty = field.value === "" || field.value === null
    if (!empty && !(decision?.mode === "overwrite" && equal(decision.before ?? null, field.value))) {
      return { ...action, status: "preserved_existing", reason: "Different existing value; review it on the target page" }
    }
    return { ...action, status: "ready", reason: "Ready to fill" }
  })
  return { id: crypto.randomUUID(), version, snapshotHash: source.hash, selectedGroups: target.selectedGroups, epoch: target.epoch,
    identity: target.identity, template: target.template, structure: target.structure, recordValues: target.recordValues, actions }
}
