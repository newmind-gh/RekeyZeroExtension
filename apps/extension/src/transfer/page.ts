import { equal, hash } from "./planner"
import { adapterFor, rootElementById } from "./control-adapters"
import type { Control, ControlAdapter } from "./control-adapters"
import { discoverDomScopes, scopeVisible } from "./dom-traversal"
import type { DomScope } from "./dom-traversal"
import type { Action, Field, Observation, PageCommand, PageReply, Value } from "./types"
import { isBlankSourceValue } from "../personal/source-prepare/source-value-normalizer"
import { clearSourceAnnotations, markSourceReview, pruneSourceAnnotations, toggleSourceEvidence } from "../content/source-review-annotations"

const epoch = crypto.randomUUID()
const ids = new WeakMap<Element, string>()
const registry = new Map<string, { control: Control; adapter: ControlAdapter; scope: DomScope }>()
const sensitive = /password|secret|token|credential|credit.?card|card.?number|cvv|cvc|api.?key|one.?time|otp/i
function labelText(element: Element): string {
  const copy = element.cloneNode(true) as Element
  copy.querySelectorAll("input, select, textarea, button, [data-rekeyzero-ui]").forEach((node) => node.remove())
  return copy.textContent?.trim() ?? ""
}
function label(element: Element): string {
  const labels = (element as HTMLInputElement).labels
  const labelled = element.getAttribute("aria-labelledby")?.split(/\s+/).map((id) => { const label = rootElementById(element, id); return label ? labelText(label) : "" }).join(" ")
  return (element.getAttribute("aria-label") || labelled || (labels && Array.from(labels).map(labelText).join(" ")) ||
    element.getAttribute("data-transfer-label") || (element.tagName === "DD" ? element.previousElementSibling?.textContent : "") ||
    element.getAttribute("name") || "").trim()
}
function groupInfo(element: Element): { value: string; recordPath: string } {
  const scopes: string[] = []
  const recordScopes: string[] = []
  let parent: Element | null = element
  while (parent) {
    const key = parent.getAttribute("data-record-id") || parent.getAttribute("data-row-key") || parent.getAttribute("data-transfer-record-id")
    if (key) {
      scopes.unshift(`Record ${key}`)
      recordScopes.unshift(key)
    }
    else if (parent.tagName === "TR") {
      if (!ids.has(parent)) ids.set(parent, crypto.randomUUID())
      scopes.unshift(`Row ${ids.get(parent)!.slice(0, 8)}`)
    }
    else if (parent.tagName === "FIELDSET") scopes.unshift(parent.querySelector(":scope > legend")?.textContent?.trim() || "Unnamed section")
    else if (parent.tagName === "FORM" && (parent.getAttribute("aria-label") || parent.id)) scopes.unshift(parent.getAttribute("aria-label") || parent.id)
    parent = parent.parentElement || ((parent.getRootNode() as ShadowRoot).host ?? null)
  }
  return { value: scopes.join(" / "), recordPath: recordScopes.join(" / ") }
}
const group = (element: Element) => groupInfo(element).value
function positionalName(value: string): { normalized: string; strong: boolean } {
  const bracketed = value.replace(/\[\d+\]/g, "[]")
  const dotted = bracketed.replace(/\.\d+(?=\.|$)/g, "[]")
  const normalized = dotted.replace(/_\d+(?=_|$)/g, "[]")
  return { normalized, strong: bracketed !== value || dotted !== bracketed }
}
const visible = scopeVisible
function eligible(element: Element): boolean {
  if (element.closest("[data-rekeyzero-ui]")) return false
  const input = element as HTMLInputElement
  const excludedTypes = element.matches('[role="combobox"]') ? ["hidden", "password", "submit", "reset", "image", "search"] :
    ["hidden", "password", "submit", "reset", "button", "image", "search"]
  return visible(element) && !excludedTypes.includes(input.type) &&
    !sensitive.test(`${input.type} ${input.name} ${input.id} ${label(element)} ${element.getAttribute("autocomplete")}`)
}
function identityEvidence(fields: Field[], scopes: DomScope[]) {
  const query = (selector: string) => scopes.flatMap((scope) => Array.from(scope.root.querySelectorAll(selector)))
  const evidence: Observation["identityEvidence"] = []
  const seen = new Set<string>()
  const add = (kind: string, label: string, raw: string | null | undefined, confidence: "high" | "medium") => {
    const value = raw?.trim()
    const identity = `${kind}:${label}:${value}`
    if (!value || seen.has(identity)) return
    seen.add(identity)
    evidence.push({ kind, label, value: value.slice(0, 200), confidence })
  }
  for (const name of ["record", "customer", "application", "order", "account", "project"]) {
    for (const element of query(`[data-${name}-id]`)) {
      add("attribute", `${name} ID`, element.getAttribute(`data-${name}-id`), "high")
    }
  }
  for (const [attribute, label] of [["data-row-key", "row key"], ["data-transfer-record-id", "adapter record ID"]]) {
    for (const element of query(`[${attribute}]`)) {
      add("attribute", label, element.getAttribute(attribute), "high")
    }
  }
  const identityLabel = /^(company name|legal company name|organisation name|organization name|customer name|customer id|record id|application id|order id|order reference|account id|project id|公司名称|客户编号|申请编号|订单编号)$/i
  for (const field of fields.filter((candidate) => identityLabel.test(candidate.label) && !candidate.writable)) {
    // Writable values are transfer payload, not trustworthy record identity. Including
    // them would make the identity change while a blank form is being filled.
    add("field", field.label, String(field.value ?? ""), "high")
  }
  const textPattern = /\b(order|application|customer|record|account|project)\s*(?:id|number|no\.?|reference|ref\.?)?\s*[:#-]\s*([A-Z0-9][A-Z0-9_-]{3,})\b/gi
  for (const element of query('h1,h2,h3,header,[role="heading"],[data-record-label],dt,th,[class*="reference" i],[class*="order" i],[class*="record" i],[class*="application" i]')) {
    const text = element.textContent?.replace(/\s+/g, " ").trim() ?? ""
    for (const match of text.matchAll(textPattern)) add("heading", `${match[1]} reference`, match[2], "high")
    const standalone = text.match(/\b(?:Q|APP|CASE|POL|REF)-[A-Z0-9_-]{3,}\b/i)?.[0]
    if (standalone) add("heading", "Page reference", standalone, "high")
  }
  return evidence
}
export async function observeTransferPage(selectedGroups?: string[]): Promise<Observation> {
  const traversal = discoverDomScopes()
  const scopeFor = new Map<Element, DomScope>()
  const all = traversal.scopes.flatMap((scope) => Array.from(scope.root.querySelectorAll("input, textarea, select, dd, [data-transfer-label], [role=combobox], [contenteditable=true]")).map((element) => { scopeFor.set(element, scope); return element }))
  const discovered = all.filter((element) => element.isConnected && eligible(element) &&
    !element.parentElement?.closest('[role="combobox"]'))
  const scopedGroup = (element: Element) => [scopeFor.get(element)!.path, group(element)].filter(Boolean).join(" / ")
  const groups = Array.from(new Set(discovered.map(scopedGroup))).map((name) => ({ name, count: discovered.filter((element) => scopedGroup(element) === name).length }))
  const candidates = selectedGroups?.length ? discovered.filter((element) => selectedGroups.includes(scopedGroup(element))) : discovered
  const fields: Field[] = []
  const identityFlags = new Map<string, { positional: boolean; strong: boolean; recordPath: string; family: string }>()
  const radioSeen = new Set<Element>()
  registry.clear()
  for (const element of candidates.slice(0, 120)) {
    if (radioSeen.has(element)) continue
    let elements = [element]
    const input = element as HTMLInputElement
    const adapter = adapterFor(element)
    const type = adapter.observe({ elements }).type
    if (type === "radio") {
      if (!input.name) elements = [element]
      else elements = candidates.filter((e) => e.tagName === "INPUT" && (e as HTMLInputElement).type === "radio" && (e as HTMLInputElement).name === input.name && (e as HTMLInputElement).form === input.form && scopedGroup(e) === scopedGroup(element))
      elements.forEach((e) => radioSeen.add(e))
    }
    if (!ids.has(element)) ids.set(element, crypto.randomUUID())
    const id = ids.get(element)!
    const control = { elements }
    const description = adapter.observe(control)
    registry.set(id, { control, adapter, scope: scopeFor.get(element)! })
    const scope = groupInfo(element)
    const fieldGroup = scopedGroup(element)
    const fieldLabel = type === "radio" ? element.closest("fieldset")?.querySelector(":scope > legend")?.textContent?.trim() || input.name || label(element) : label(element)
    const locator = element.getAttribute("name") || element.id || fieldLabel
    const options = description.options
    const raw = adapter.read(control)
    const templateGroup = fieldGroup.replace(/Record [^/]+/g, "Record").replace(/Row [^/]+/g, "Row")
    const positional = positionalName(locator)
    const positionalField = positional.normalized !== locator
    const templateKey = await hash([templateGroup, positional.normalized, type])
    const instanceKey = await hash([fieldGroup, positionalField ? positional.normalized : locator, type])
    const family = JSON.stringify([scope.recordPath, positional.normalized, type])
    identityFlags.set(id, { positional: positionalField, strong: positional.strong, recordPath: scope.recordPath, family })
    fields.push({ id, templateKey, identityKey: await hash([templateGroup, positional.normalized]), instanceKey,
      templateStable: Boolean(locator), instanceStable: Boolean(locator && !fieldGroup.includes("Row ")), ambiguousInObservation: false,
      label: fieldLabel || "Unnamed field", group: fieldGroup, type, value: raw,
      display: options.find((o) => o.value === raw)?.label ?? String(raw ?? "Not selected"), options,
      required: elements.some((e) => (e as HTMLInputElement).required),
      writable: description.writable, adapterId: adapter.id, semanticType: description.semanticType, scope: scopeFor.get(element)!.path,
      reusable: Boolean(locator && !fieldGroup.includes("Row ")) })
  }
  const templateCounts = new Map<string, number>()
  const instanceCounts = new Map<string, number>()
  const familyCounts = new Map<string, number>()
  fields.forEach((field) => {
    templateCounts.set(field.templateKey, (templateCounts.get(field.templateKey) ?? 0) + 1)
    instanceCounts.set(field.instanceKey, (instanceCounts.get(field.instanceKey) ?? 0) + 1)
    const family = identityFlags.get(field.id)!.family
    familyCounts.set(family, (familyCounts.get(family) ?? 0) + 1)
  })
  fields.forEach((f) => {
    f.ambiguousInObservation = templateCounts.get(f.templateKey)! > 1
    if (f.ambiguousInObservation) f.reusable = false
    if (instanceCounts.get(f.instanceKey)! > 1) f.instanceStable = false
    const flags = identityFlags.get(f.id)!
    if (flags.positional && ((!flags.recordPath && flags.strong) || familyCounts.get(flags.family)! > 1)) f.instanceStable = false
  })
  const template = await hash([location.origin, fields.map((f) => [f.templateKey, f.type]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))])
  const structure = await hash([location.href, fields.map((f) => [f.instanceKey, f.id, f.type, f.writable, f.options, f.adapterId, scopeFor.get(registry.get(f.id)!.control.elements[0])!.token])])
  const identityFields = fields.filter((f) => /^(company name|legal company name|organisation name|organization name|customer name|customer id|record id|application id|公司名称|客户编号)$/i.test(f.label))
  const recordValues = Object.fromEntries(identityFields.map((f) => [f.id, f.value]))
  const evidence = identityEvidence(fields, traversal.scopes)
  const identityConfidence: Observation["identityConfidence"] = evidence.some((item) => item.confidence === "high") ? "high" :
    evidence.length ? "medium" : fields.filter((field) => field.writable).every((field) => field.value === "" || field.value === null || field.value === false) ? "new_form" : "uncertain"
  const pageIdentity = await hash([location.href, document.title, evidence.map((item) => [item.kind, item.label, item.value]), traversal.scopes.filter((scope) => scope.path).map((scope) => [scope.path, scope.url])])
  const identity = pageIdentity
  pruneSourceAnnotations(pageIdentity)
  return { epoch, identity, pageIdentity, identityEvidence: evidence, identityConfidence, template, structure, origin: location.origin, title: document.title, fields,
    recordValues, groups, selectedGroups,
    blockedReason: traversal.scopes.some((scope) => Array.from(scope.root.querySelectorAll('input[type="password"]')).some(visible)) || /\b(log\s?in|sign\s?in|authentication)\b/i.test(document.title)
      ? "Please sign in and open the intended form before filling" : undefined,
    scannedCount: all.length, eligibleCount: candidates.length, truncated: candidates.length > 120 || traversal.limited }
}
const invalid = (elements: Element[]) => elements.some((element) => {
  const validity = (element as HTMLInputElement).validity
  return (validity ? !validity.valid : false) || element.getAttribute("aria-invalid") === "true"
})
export async function executeGuardedPageAction(request: PageCommand): Promise<Action> {
  const plan = request.plan!
  const action = plan.actions.find((a) => a.id === request.actionId)
  if (!action || action.status !== "ready") throw new Error("Invalid fill action")
  const current = await observeTransferPage(plan.selectedGroups)
  if (current.blockedReason || plan.epoch !== epoch || plan.identity !== current.identity || plan.template !== current.template || plan.structure !== current.structure) return { ...action, status: "stale", reason: "Page identity or structure changed; review this target" }
  const recordMatches = (observation: Observation) => Object.entries(plan.recordValues ?? {}).every(([id, before]) =>
    equal(observation.recordValues?.[id] ?? null, before) || (id === action.field.id && equal(observation.recordValues?.[id] ?? null, action.expected)))
  if (!recordMatches(current)) return { ...action, status: "stale", reason: "Target customer identity changed" }
  const field = current.fields.find((f) => f.id === action.field.id)
  const binding = registry.get(action.field.id)
  const elements = binding?.control.elements
  if (!field?.writable || !binding || !elements || !binding.scope.connected() || field.type !== action.field.type) return { ...action, status: "unsupported", reason: "Control is unavailable or not editable" }
  if (request.blankOnly && !isBlankSourceValue(field.value)) return { ...action, status: "preserved_existing", observed: field.value, reason: "Existing source value preserved" }
  const currentMatches = (value: Value) => request.requireExactValue ? Object.is(value, action.before) : equal(value, action.before)
  if (request.requireExactValue && !currentMatches(field.value)) return { ...action, status: "preserved_existing", observed: field.value, reason: "User-edited source value preserved" }
  if (equal(field.value, action.expected)) {
    const markedInvalid = !request.requireExactValue && invalid(elements)
    return { ...action, status: markedInvalid ? "validation_failed" : "already_equal", observed: field.value, reason: markedInvalid ? "Current value is marked invalid" : "Read-back already matches" }
  }
  if (!currentMatches(field.value)) return { ...action, status: "stale", observed: field.value, reason: "Value changed after preparation" }
  if (request.operation === "read") return { ...action, status: "ready", observed: field.value, reason: "Original value still present; safe to retry" }
  if (field.options.length && !(request.requireExactValue && field.type === "radio" && action.expected === null) && !field.options.some((o) => o.value === action.expected)) return { ...action, status: "stale", reason: "Accepted options changed" }
  try {
    await binding.adapter.writeValue(binding.control, action.expected, field.options, async () => {
      const guarded = await observeTransferPage(plan.selectedGroups)
      const latest = guarded.fields.find((candidate) => candidate.id === field.id)
      if (guarded.blockedReason || !binding.scope.connected() || guarded.epoch !== plan.epoch || guarded.identity !== plan.identity ||
        guarded.template !== plan.template || guarded.structure !== plan.structure || !recordMatches(guarded) ||
        !latest?.writable || !currentMatches(latest.value) || (request.blankOnly && !isBlankSourceValue(latest.value))) throw new Error("Page or control changed before write")
    })
    let observed = binding.adapter.read(binding.control)
    for (let i = 0; i < 4; i++) {
      await new Promise((resolve) => setTimeout(resolve, 150))
      observed = binding.adapter.read(binding.control)
      if (!binding.scope.connected() || !elements.every((e) => e.isConnected)) return { ...action, status: "unknown", observed, reason: "Control was replaced; re-observe before retry" }
    }
    // Undo may restore an originally blank required control. Verify its exact
    // prior value without treating the page's required-state validation as a fill error.
    const markedInvalid = !request.requireExactValue && invalid(elements)
    const after = await observeTransferPage(plan.selectedGroups)
    if (after.identity !== plan.identity || after.epoch !== plan.epoch || !recordMatches(after)) return { ...action, observed, status: "unknown", reason: "Page identity changed during write" }
    const verified = request.requireExactValue ? Object.is(observed, action.expected) : binding.adapter.verifyValue(binding.control, action.expected)
    return { ...action, observed, status: verified && !markedInvalid ? "filled_verified" : "validation_failed",
      reason: verified && !markedInvalid ? "Filled and checked on page" : "Page rejected, reverted or marked this value invalid" }
  } catch (error) {
    return { ...action, status: "validation_failed", reason: error instanceof Error ? error.message : "Control rejected value" }
  }
}
export async function handleTransferPage(request: PageCommand): Promise<PageReply> {
  const envelope = { transferId: request.transferId, targetId: request.targetId, tabId: request.tabId,
    documentEpoch: epoch, requestId: request.requestId }
  try {
    if (request.documentEpoch && request.documentEpoch !== epoch) throw new Error("Document changed")
    if (request.operation === "observe") return { ok: true, envelope, observation: await observeTransferPage(request.selectedGroups) }
    if (request.operation === "apply" || request.operation === "read") return { ok: true, envelope, action: await executeGuardedPageAction(request) }
    if (request.operation === "annotate_source" && request.sourceReview) {
      const mark = request.sourceReview
      const current = await observeTransferPage(request.selectedGroups)
      const field = current.fields.find((candidate) => candidate.id === mark.fieldId)
      const binding = registry.get(mark.fieldId)
      let sourceAnnotationShown = false
      if (!current.blockedReason && current.pageIdentity === mark.pageIdentity && current.structure === mark.sourceFingerprint
        && field && binding && Object.is(field.value, mark.appliedValue)) sourceAnnotationShown = markSourceReview(mark, binding.control)
      return { ok: true, envelope, sourceAnnotationShown }
    }
    if (request.operation === "clear_source_annotations") { clearSourceAnnotations(request.sourcePrepareSessionId); return { ok: true, envelope } }
    if (request.operation === "toggle_source_evidence" && request.sourcePrepareSessionId) {
      toggleSourceEvidence(request.sourcePrepareSessionId, Boolean(request.evidenceVisible)); return { ok: true, envelope }
    }
    throw new Error("Unsupported transfer page operation")
  } catch (error) { return { ok: false, envelope, error: error instanceof Error ? error.message : "Page operation failed" } }
}
