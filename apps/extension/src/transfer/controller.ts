import { guardedPageRequest, siteOrigin } from "./guarded-page-client"
import { driftReport, fieldTemplates, hasBaselineOverlap } from "./profile-drift"
import { removeHostPermissionIfUnused } from "../personal/permissions/host-permissions"
import { configuredBuiltinApiOrigins } from "../personal/ai/direct-api-provider"
import { hash, planTransfer, snapshot, successful } from "./planner"
import { deleteProfile, loadSession, notifyProfilesChanged, pagePathPattern, profiles, putProfile, saveSession, SESSION_KEY } from "./store"
import type { Command, MappingProfile, Observation, PageCommand, PageReply, ProfileFieldMapping, ProfilePageTemplate, ProfileTargetTemplate, Session, Snapshot, Target } from "./types"

let current: Session | undefined
let loaded: Promise<void> | undefined
let queue: Promise<unknown> = Promise.resolve()
let running = false
let generation = 0
const pendingOrigins = new Set<string>()
const inflight = new Set<string>()
async function persist(value: Session, expectedGeneration = generation): Promise<void> {
  if (expectedGeneration !== generation || current !== value) return
  await saveSession(value)
}
export async function resetTransferRuntime(): Promise<void> {
  generation += 1
  const stale = current
  if (stale) stale.status = "cancelled"
  current = undefined
  loaded = undefined
  queue = Promise.resolve()
  running = false
  pendingOrigins.clear()
  inflight.clear()
  await chrome.storage.session.remove(SESSION_KEY)
}
function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work)
  queue = next.catch(() => undefined)
  return next
}
async function session(): Promise<Session> {
  loaded ??= loadSession().then((saved) => {
    current = saved ?? { id: crypto.randomUUID(), revision: 0, status: "draft", frozen: false, targets: [] }
    if (current.status === "running") { current.status = "partial"; current.error = "Worker restarted. Resume to check uncertain results before retrying." }
  })
  await loaded
  return current!
}
export { siteOrigin } from "./guarded-page-client"
async function page(s: Session, tabId: number, targetId: string, operation: PageCommand["operation"], extra: Partial<PageCommand> = {}): Promise<PageReply> {
  return guardedPageRequest(s.id, tabId, targetId, operation, extra)
}
async function observe(s: Session, tabId: number, targetId: string, selectedGroups?: string[]): Promise<Observation> {
  selectedGroups ??= targetId.startsWith("source") ? s.source?.selectedGroups : s.targets.find((target) => target.id === targetId)?.observation?.selectedGroups
  const reply = await page(s, tabId, targetId, "observe", { selectedGroups })
  if (!reply.observation) throw new Error("Page observation is unavailable")
  return reply.observation
}
function aggregate(s: Session) {
  if (s.status === "cancelled" || s.status === "failed") return
  if (running || s.targets.some((t) => t.status === "running")) s.status = "running"
  else if (s.targets.length && s.targets.every((t) => t.status === "completed")) s.status = "completed"
  else if (s.frozen) s.status = "partial"
  else s.status = s.targets.some((t) => t.plan?.actions.some((a) => a.status === "ready")) ? "ready" : "needs_input"
}
async function prepareTarget(s: Session, t: Target) {
  try {
    const tab = await chrome.tabs.get(t.tabId)
    if (!await chrome.permissions.contains({ origins: [`${t.origin}/*`] })) throw new Error("Allow this website before reading or filling")
    if (siteOrigin(tab.url ?? "") !== t.origin) throw new Error("Target navigated to another website. Open the intended form and resume.")
    if (tab.status !== "complete") throw new Error("Waiting for page load; resume when the form is ready")
    const observation = await observe(s, t.tabId, t.id)
    if (s.mappingProfileId && t.observation && observation.template !== t.observation.template) throw new Error("Target structure changed. Prepare the profile again to review drift.")
    if (s.profileDrift && t.observation && observation.structure !== t.observation.structure) throw new Error("Target changed during drift review. Prepare the profile again.")
    t.observation = observation
    t.title = observation.title
    if (observation.blockedReason) throw new Error(observation.blockedReason)
    if (observation.identityConfidence === "uncertain") {
      if (!t.confirmedIdentity) t.confirmedIdentity = observation.pageIdentity
      else if (t.confirmedIdentity !== observation.pageIdentity) throw new Error("Target record changed. Select the intended target tab again.")
    }
    if (!observation.fields.length) throw new Error("Please log in or open the form, then resume this target")
    if (!s.source) throw new Error("Select a source first")
    t.plan = planTransfer(s.source, observation, t.decisions, s.revision, Boolean(s.mappingProfileId))
    t.status = t.plan.actions.some((a) => a.status === "ready") ? "ready" : "needs_input"
    t.error = undefined
  } catch (error) { t.status = "waiting_user"; t.error = error instanceof Error ? error.message : "Unable to prepare target" }
}
function profilePage(observation: Observation, rawUrl: string): ProfilePageTemplate {
  const pathPattern = pagePathPattern(rawUrl)
  let title = observation.title
  for (const evidence of observation.identityEvidence) title = title.split(evidence.value).join("Record")
  return {
    origin: observation.origin,
    pathPattern,
    template: observation.template,
    fields: fieldTemplates(observation),
    selectedGroups: observation.selectedGroups,
    title: title.trim() || `${new URL(observation.origin).hostname}${pathPattern}`,
  }
}
function pageOriginMatches(tab: chrome.tabs.Tab, template: ProfilePageTemplate): boolean {
  if (!tab.id || !tab.url || !/^https?:/.test(tab.url)) return false
  const url = new URL(tab.url)
  return url.origin === template.origin
}
function decisionsFromProfile(source: Snapshot, observation: Observation, configured: ProfileFieldMapping[], blockedSourceKeys: string[] = [], blockedTargetKeys: string[] = []) {
  const decisions: Target["decisions"] = {}
  for (const mapping of configured) {
    const sourceFields = source.fields.filter((field) => field.templateKey === mapping.sourceTemplateKey)
    const targetFields = observation.fields.filter((field) => field.templateKey === mapping.targetTemplateKey)
    if (targetFields.length !== 1 || (mapping.existingValuePolicy !== "skip" &&
      (sourceFields.length !== 1 || blockedSourceKeys.includes(mapping.sourceTemplateKey) || blockedTargetKeys.includes(mapping.targetTemplateKey)))) {
      for (const field of targetFields) decisions[field.instanceKey] = { blockReason: "Profile mapping changed or is ambiguous; review and save a new revision" }
      continue
    }
    const targetField = targetFields[0]
    const sourceField = sourceFields[0]
    decisions[targetField.instanceKey] = {
      sourceInstanceKey: sourceField?.instanceKey,
      mode: mapping.existingValuePolicy === "overwrite" ? "overwrite" : mapping.existingValuePolicy === "skip" ? "skip" : undefined,
      before: targetField.value,
    }
  }
  return decisions
}
async function saveMappingProfile(s: Session, command: Extract<Command, { type: "SAVE_MAPPING_PROFILE" }>): Promise<MappingProfile> {
  if (!s.source || s.sourceTabId === undefined) throw new Error("Prepare a source page before creating a Mapping Profile")
  if (!command.name.trim()) throw new Error("Enter a Mapping Profile name")
  const existing = command.profileId ? (await profiles()).find((profile) => profile.id === command.profileId) : undefined
  const sourceTab = await chrome.tabs.get(s.sourceTabId)
  const freshSource = await observe(s, s.sourceTabId, "source-save")
  if (freshSource.epoch !== s.source.epoch || freshSource.identity !== s.source.identity || freshSource.template !== s.source.template || freshSource.structure !== s.source.structure) throw new Error("Source changed before saving. Prepare the profile again.")
  const targets: ProfileTargetTemplate[] = []
  for (const configuredTarget of command.targets) {
    const target = s.targets.find((candidate) => candidate.id === configuredTarget.targetId)
    if (!target?.observation) throw new Error("Prepare every selected target before saving the profile")
    const targetTab = await chrome.tabs.get(target.tabId)
    const freshTarget = await observe(s, target.tabId, target.id)
    if (freshTarget.epoch !== target.observation.epoch || freshTarget.identity !== target.observation.identity || freshTarget.template !== target.observation.template || freshTarget.structure !== target.observation.structure) throw new Error("Target changed before saving. Prepare the profile again.")
    const configuredMappings: ProfileFieldMapping[] = configuredTarget.mappings.map((configured) => {
      const targetField = target.observation!.fields.find((field) => field.instanceKey === configured.targetInstanceKey)
      const sourceField = configured.sourceInstanceKey ? s.source!.fields.find((field) => field.instanceKey === configured.sourceInstanceKey) : undefined
      if (!targetField || (configured.existingValuePolicy !== "skip" && !sourceField)) throw new Error("Complete or skip every target field in the profile")
      if (configured.existingValuePolicy !== "skip" && (s.source!.fields.filter((field) => field.templateKey === sourceField!.templateKey).length !== 1 ||
        target.observation!.fields.filter((field) => field.templateKey === targetField.templateKey).length !== 1)) {
        throw new Error("Repeated fields need a stable, unique page-template identity before they can be saved in a profile")
      }
      return {
        sourceTemplateKey: sourceField?.templateKey ?? "",
        targetTemplateKey: targetField.templateKey,
        existingValuePolicy: configured.existingValuePolicy,
      }
    })
    targets.push({ id: crypto.randomUUID(), ...profilePage(target.observation, targetTab.url ?? ""), mappings: configuredMappings })
  }
  if (!targets.length) throw new Error("Add at least one prepared target to the profile")
  const duplicate = targets.find((target, index) => targets.findIndex((candidate) => candidate.origin === target.origin && candidate.pathPattern === target.pathPattern && candidate.template === target.template) !== index)
  if (duplicate) throw new Error("A Mapping Profile needs one definition per target page type")
  const now = new Date().toISOString()
  const saved = await putProfile({
    id: existing?.id ?? crypto.randomUUID(),
    name: command.name.trim(),
    kind: command.kind ?? existing?.kind ?? "profile",
    version: 2,
    revision: (existing?.revision ?? (existing ? 1 : 0)) + 1,
    source: profilePage(s.source, sourceTab.url ?? ""),
    targets,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  })
  await notifyProfilesChanged()
  return saved
}
async function profileCandidates(s: Session, tabs: chrome.tabs.Tab[], baseline: ProfilePageTemplate, id: string) {
  const candidates: { tab: chrome.tabs.Tab; observation: Observation }[] = []
  for (const tab of tabs.filter((candidate) => pageOriginMatches(candidate, baseline))) {
    const observation = await observe(s, tab.id!, id, baseline.selectedGroups).catch(() => undefined)
    if (observation && !observation.blockedReason) candidates.push({ tab, observation })
  }
  const exact = candidates.filter(({ observation }) => observation.template === baseline.template)
  if (exact.length) return exact
  return candidates.filter(({ tab, observation }) => pagePathPattern(tab.url!) === baseline.pathPattern
    && profilePage(observation, tab.url!).title === baseline.title && hasBaselineOverlap(baseline, observation))
}
async function useMappingProfile(profile: MappingProfile, includeAllTargetInstances = true): Promise<Session> {
  const s: Session = { id: crypto.randomUUID(), revision: 0, status: "draft", frozen: false, targets: [], mappingProfileId: profile.id }
  const openTabs = (await chrome.tabs.query({})).filter((tab) => tab.id && tab.url && /^https?:/.test(tab.url))
  let sourceMatches = await profileCandidates(s, openTabs, profile.source, "source-profile-match")
  const sourceTitleMatches = sourceMatches.filter((match) => profilePage(match.observation, match.tab.url ?? "").title === profile.source.title)
  if (sourceTitleMatches.length) sourceMatches = sourceTitleMatches
  const preferredSources = sourceMatches.filter((match) => pagePathPattern(match.tab.url!) === profile.source.pathPattern)
  if (preferredSources.length) sourceMatches = preferredSources
  if (!sourceMatches.length) throw new Error(`Open the source page for ${profile.name}`)
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const sourceMatch = sourceMatches.length === 1 ? sourceMatches[0] : sourceMatches.find((match) => match.tab.id === activeTab?.id)
  if (!sourceMatch) throw new Error("Several source pages match this profile. Activate the intended source tab and prepare again.")
  s.sourceTabId = sourceMatch.tab.id
  s.source = await snapshot(sourceMatch.observation)
  s.confirmedSourceIdentity = s.source.pageIdentity
  const sourceReport = driftReport(profile.source, s.source, profile.targets.flatMap((target) =>
    target.mappings.filter((mapping) => mapping.existingValuePolicy !== "skip").map((mapping) => mapping.sourceTemplateKey)), "source")
  const reports: import("./types").ProfileDriftReport[] = []
  if (sourceMatch.observation.template !== profile.source.template) reports.push(sourceReport)
  const usedTabs = new Set<number>([s.sourceTabId!])
  for (const targetTemplate of profile.targets) {
    let matches = await profileCandidates(s, openTabs.filter((tab) => !usedTabs.has(tab.id!)), targetTemplate, targetTemplate.id)
    const titleMatches = matches.filter((match) => profilePage(match.observation, match.tab.url ?? "").title === targetTemplate.title)
    if (titleMatches.length) matches = titleMatches
    const preferredTargets = matches.filter((match) => pagePathPattern(match.tab.url!) === targetTemplate.pathPattern)
    if (preferredTargets.length) matches = preferredTargets
    if (!matches.length) throw new Error(`Open the target page: ${targetTemplate.title}`)
    if (!includeAllTargetInstances && matches.length > 1 && matches.some((match) => match.observation.template !== targetTemplate.template)) throw new Error("Several changed target pages match. Keep only the intended target open before reviewing drift.")
    for (const match of includeAllTargetInstances ? matches : matches.slice(0, 1)) {
      usedTabs.add(match.tab.id!)
      const targetId = crypto.randomUUID()
      const targetReport = driftReport(targetTemplate, match.observation,
        targetTemplate.mappings.filter((mapping) => mapping.existingValuePolicy !== "skip").map((mapping) => mapping.targetTemplateKey), "target", targetId)
      if (match.observation.template !== targetTemplate.template) reports.push(targetReport)
      const target: Target = {
        id: targetId,
        tabId: match.tab.id!,
        windowId: match.tab.windowId,
        origin: match.observation.origin,
        title: match.observation.title,
        status: "preparing",
        observation: match.observation,
        decisions: decisionsFromProfile(s.source, match.observation, targetTemplate.mappings, sourceReport.blockedKeys, targetReport.blockedKeys),
        confirmedIdentity: match.observation.identityConfidence === "uncertain" ? match.observation.pageIdentity : undefined,
      }
      target.plan = planTransfer(s.source, match.observation, target.decisions, s.revision, Boolean(s.mappingProfileId))
      target.status = target.plan.actions.some((action) => action.status === "ready") ? "ready" : "needs_input"
      s.targets.push(target)
    }
  }
  if (reports.length) s.profileDrift = { reviewed: false, reports }
  aggregate(s)
  return s
}
async function executeTarget(s: Session, t: Target) {
  const expectedGeneration = generation
  let plan = t.plan!
  if (plan.snapshotHash !== s.source?.hash) throw new Error("Fill plan is bound to a different source snapshot")
  t.status = "running"
  await serial(() => persist(s, expectedGeneration))
  try {
    for (let index = 0; index < plan.actions.length; index++) {
      let action = plan.actions[index]
      if (s.status === "cancelled" || expectedGeneration !== generation) break
      if (action.status !== "ready" && action.status !== "unknown") continue
      const recovering = action.status === "unknown"
      const tab = await chrome.tabs.get(t.tabId)
      if (siteOrigin(tab.url ?? "") !== t.origin) throw new Error("Target website changed")
      plan.actions[index] = { ...action, status: "unknown", reason: "Awaiting page result" }
      await serial(() => persist(s, expectedGeneration))
      if (s.status === "cancelled" || expectedGeneration !== generation) break
      const executable = { ...plan, actions: [{ ...action, status: "ready" as const }] }
      let reply = await page(s, t.tabId, t.id, recovering ? "read" : "apply", {
        documentEpoch: plan.epoch, plan: executable, actionId: action.id,
      })
      if (recovering && reply.action?.status === "ready" && s.status !== "cancelled") reply = await page(s, t.tabId, t.id, "apply", { documentEpoch: plan.epoch, plan: executable, actionId: action.id })
      if (!reply.action) throw new Error("Missing field result")
      action = reply.action
      plan.actions[index] = action
      if (successful(action.status) && plan.recordValues && action.field.id in plan.recordValues) plan.recordValues[action.field.id] = action.expected
      await serial(() => persist(s, expectedGeneration))
      if (successful(action.status)) {
        const refreshed = await observe(s, t.tabId, t.id)
        if (refreshed.identity !== plan.identity) {
          plan.actions[index] = { ...action, status: "unknown", reason: "Page identity changed after the write" }
          break
        }
        if (refreshed.structure !== plan.structure) {
          const completed = new Map(plan.actions.filter((item) => successful(item.status)).map((item) => [item.field.instanceKey, item]))
          const replanned = planTransfer(s.source!, refreshed, t.decisions, s.revision, Boolean(s.mappingProfileId))
          replanned.actions = replanned.actions.map((item) => completed.get(item.field.instanceKey) ?? item)
          t.observation = refreshed
          t.plan = replanned
          plan = replanned
          index = -1
          await serial(() => persist(s, expectedGeneration))
          continue
        }
      }
      if (action.status === "stale" || action.status === "unknown") break
    }
    t.status = plan.actions.every((a) => successful(a.status) || a.status === "skipped" ||
      (a.status === "preserved_existing" && t.decisions[a.field.instanceKey]?.mode === "preserve")) ? "completed" : "partial"
  } catch (error) { t.status = "waiting_user"; t.error = error instanceof Error ? error.message : "Target failed" }
  await serial(async () => { aggregate(s); await persist(s, expectedGeneration) })
}
async function drain(s: Session) {
  if (running) return
  const expectedGeneration = generation
  running = true
  try {
    const jobs = s.targets.filter((t) => t.plan && ["ready", "needs_input", "running"].includes(t.status))
    const consume = async () => {
      while (s.status !== "cancelled" && expectedGeneration === generation) {
        const index = jobs.findIndex((t) => !pendingOrigins.has(t.origin))
        if (index < 0) return
        const [target] = jobs.splice(index, 1)
        pendingOrigins.add(target.origin); inflight.add(target.id)
        try { await executeTarget(s, target) }
        finally {
          if (expectedGeneration === generation) {
            pendingOrigins.delete(target.origin)
            inflight.delete(target.id)
          }
        }
      }
    }
    await Promise.all([consume(), consume(), consume()])
  } catch (error) { s.error = error instanceof Error ? error.message : "Unable to checkpoint batch"; s.status = "failed" }
  finally {
    if (expectedGeneration === generation) {
      running = false
      await serial(async () => { aggregate(s); await persist(s, expectedGeneration) })
    }
  }
}
export async function transferCommand(command: Command): Promise<unknown> {
  if (command.type === "RESET_TRANSFER") {
    await resetTransferRuntime()
    const reset = await session()
    await persist(reset)
    return reset
  }
  return serial(async () => {
    const s = await session()
    if (command.type === "GET_TRANSFER") return s
    if (command.type === "GET_MAPPING_PROFILES") return profiles()
    if (command.type === "SET_TRANSFER_ACTIVE") { s.panelActive = command.active; await persist(s); return s }
    if (command.type === "CANCEL_TRANSFER") {
      s.status = "cancelled"
      s.targets.forEach((t) => t.plan?.actions.forEach((a) => { if (a.status === "ready") a.status = "cancelled" }))
      await persist(s); return s
    }
    if (running || s.status === "running") {
      if (command.type === "RUN_TRANSFER") return s
      throw new Error("Wait for this batch or cancel before changing its plan")
    }
    if (command.type === "DELETE_MAPPING_PROFILE") {
      const deleted = (await profiles()).find((profile) => profile.id === command.profileId)
      await deleteProfile(command.profileId)
      const remaining = await profiles()
      await notifyProfilesChanged()
      if (deleted) {
        const providerOrigins = await configuredBuiltinApiOrigins()
        const origins = [...new Set([deleted.source.origin, ...deleted.targets.map((target) => target.origin)])]
        await Promise.all(origins.map((origin) => removeHostPermissionIfUnused({
          origin,
          providerOrigins,
          profiles: remaining,
        }).catch(() => false)))
      }
      return remaining
    }
    if (command.type === "SAVE_MAPPING_PROFILE") return saveMappingProfile(s, command)
    if (command.type === "APPLY_AI_FIELD_MATCHES") {
      if (!s.source) throw new Error("Select a source page before running Local AI")
      for (const configuredTarget of command.targets) {
        const target = s.targets.find((candidate) => candidate.id === configuredTarget.targetId)
        if (!target?.observation) throw new Error("Prepare every target page before running Local AI")
        for (const mapping of configuredTarget.mappings) {
          const sourceField = s.source.fields.find((field) => field.instanceKey === mapping.sourceInstanceKey)
          const targetField = target.observation.fields.find((field) => field.instanceKey === mapping.targetInstanceKey)
          if (!sourceField || !targetField) throw new Error("Local AI returned a field outside the prepared pages")
          target.decisions[targetField.instanceKey] = {
            sourceInstanceKey: sourceField.instanceKey,
            before: targetField.value,
          }
        }
        target.plan = planTransfer(s.source, target.observation, target.decisions, s.revision, Boolean(s.mappingProfileId))
        target.status = target.plan.actions.some((action) => action.status === "ready") ? "ready" : "needs_input"
      }
      aggregate(s); await persist(s); return s
    }
    if (command.type === "USE_MAPPING_PROFILE" || command.type === "OPEN_MAPPING_PROFILE") {
      const profile = (await profiles()).find((candidate) => candidate.id === command.profileId)
      if (!profile) throw new Error("Mapping Profile is unavailable")
      current = await useMappingProfile(profile, command.type === "USE_MAPPING_PROFILE")
      await persist(current)
      return current
    }
    if (command.type === "APPROVE_PROFILE_DRIFT") {
      if (!s.profileDrift || !s.source || s.sourceTabId === undefined) throw new Error("No Profile Drift is awaiting review")
      const bindings = [{ tabId: s.sourceTabId, id: "source", observation: s.source },
        ...s.targets.map((target) => ({ tabId: target.tabId, id: target.id, observation: target.observation! }))]
      for (const binding of bindings) {
        const fresh = await observe(s, binding.tabId, binding.id)
        const old = binding.observation
        if (fresh.epoch !== old.epoch || fresh.identity !== old.identity || fresh.template !== old.template || fresh.structure !== old.structure) {
          throw new Error("Page changed during drift review. Prepare the profile again.")
        }
      }
      s.profileDrift.reviewed = true
      await persist(s)
      return s
    }
    if (command.type === "SET_SOURCE") {
      if (s.frozen) throw new Error("Start a new batch to use updated source data")
      if (s.targets.some((t) => t.tabId === command.tabId)) throw new Error("Source cannot also be a target")
      const observation = await observe(s, command.tabId, "source", command.group ? [command.group] : [])
      s.sourceTabId = command.tabId; s.source = await snapshot(observation, command.group)
      s.sourceChanged = false
      s.confirmedSourceIdentity = s.source.pageIdentity
      s.targets.forEach((t) => { t.decisions = {}; t.plan = undefined })
    }
    if (command.type === "CONFIRM_SOURCE_IDENTITY") {
      if (!s.source) throw new Error("Select a source first")
      s.confirmedSourceIdentity = s.source.pageIdentity
      await persist(s); return s
    }
    if (command.type === "ADD_TARGETS") {
      if (s.frozen) throw new Error("Frozen batches cannot add or remove targets")
      const tabIds = [...new Set(command.tabIds)]
      for (const tabId of new Set(tabIds)) {
        if (s.sourceTabId === tabId) throw new Error("Source cannot also be a target")
        if (s.targets.some((t) => t.tabId === tabId)) continue
        const tab = await chrome.tabs.get(tabId)
        s.targets.push({ id: crypto.randomUUID(), tabId, windowId: tab.windowId, origin: siteOrigin(tab.pendingUrl || tab.url || ""),
          title: tab.title || "New page", status: "preparing", decisions: {} })
      }
    }
    if (command.type === "SET_TARGET_GROUPS") {
      if (s.frozen || s.mappingProfileId) throw new Error("Select sections while creating a new Profile")
      const target = s.targets.find((candidate) => candidate.id === command.targetId)
      if (!target) throw new Error("Target is unavailable")
      target.observation = await observe(s, target.tabId, target.id, command.groups)
      target.decisions = {}; target.plan = undefined
    }
    if (command.type === "REMOVE_TARGET") {
      if (s.frozen) throw new Error("Frozen batches cannot add or remove targets")
      s.targets = s.targets.filter((t) => t.id !== command.targetId)
    }
    if (command.type === "CONFIRM_TARGET_IDENTITY") {
      const target = s.targets.find((t) => t.id === command.targetId)
      if (!target?.observation) throw new Error("Observe this target before confirming its identity")
      target.confirmedIdentity = target.observation.pageIdentity
      await prepareTarget(s, target)
      aggregate(s); await persist(s); return s
    }
    if (command.type === "RUN_TRANSFER") {
      if (s.profileDrift && !s.profileDrift.reviewed) throw new Error("Review and approve Profile Drift before filling")
      if (!s.mappingProfileId) throw new Error("Select a Mapping Profile before filling")
      if (!s.source || s.sourceTabId === undefined) throw new Error("Select a source page")
      if (s.source.identityConfidence === "uncertain" && s.confirmedSourceIdentity !== s.source.pageIdentity) throw new Error("Confirm the source record identity before filling")
      if (!s.frozen) {
        const fresh = await snapshot(await observe(s, s.sourceTabId, "source"), s.source.group)
        if (fresh.epoch !== s.source.epoch || fresh.identity !== s.source.identity || fresh.template !== s.source.template) {
          throw new Error("Source record or structure changed. Select the source again and review the new preview.")
        }
        const identityFieldChanged = Object.entries(fresh.recordValues ?? {}).some(([id, value]) => s.source!.recordValues?.[id] !== value)
        if (identityFieldChanged) throw new Error("Source customer identity changed. Select the source again to confirm the new record.")
        const records = new Set(fresh.fields.map((f) => f.group).filter((g) => /Record |Row /.test(g)))
        if (records.size > 1 && !fresh.group) throw new Error("Choose one source record/group before filling")
        s.source = fresh
        s.sourceChanged = false
        for (const target of s.targets) if (target.observation && target.plan && ["ready", "needs_input"].includes(target.status)) {
          target.plan = planTransfer(fresh, target.observation, target.decisions, s.revision, Boolean(s.mappingProfileId))
          target.status = "ready"
        }
      }
      if (s.source.hash !== await hash({ identity: s.source.identity, template: s.source.template, fields: s.source.fields, group: s.source.group })) throw new Error("Source snapshot integrity check failed")
      if (!s.targets.some((t) => t.plan)) throw new Error("No target pages are prepared")
      s.frozen = true; s.status = "running"; s.error = undefined
      await persist(s)
      setTimeout(() => { void drain(s).catch(() => undefined) }, 0)
      return s
    }
    if (command.type === "RESUME_TARGET") {
      const target = s.targets.find((t) => t.id === command.targetId)
      if (!target) throw new Error("Target is unavailable")
      if (target.plan?.actions.some((a) => a.status === "unknown")) target.status = "ready"
      else {
        const completed = new Map(target.plan?.actions.filter((a) => successful(a.status)).map((a) => [a.field.id, a]))
        await prepareTarget(s, target)
        target.plan?.actions.forEach((a, index) => { const prior = completed.get(a.field.id); if (prior) target.plan!.actions[index] = prior })
      }
    } else {
      for (const target of s.targets) if (!s.frozen || !target.plan) await prepareTarget(s, target)
    }
    aggregate(s); await persist(s); return s
  })
}
export function invalidateTransferTab(tabId?: number) {
  void serial(async () => {
    const s = await session()
    for (const target of s.targets.filter((t) => tabId === undefined || t.tabId === tabId)) {
      if (!target.plan) continue
      target.plan.actions.forEach((a) => { if (a.status === "ready") { a.status = "stale"; a.reason = "Page or permission changed; resume to review" } })
      if (!inflight.has(target.id)) target.status = "waiting_user"
    }
    await persist(s)
  }).catch(() => undefined)
}

export async function transferOwnsTab(tabId: number): Promise<boolean> {
  const s = await session()
  return (s.panelActive !== false || running || s.status === "running") && (s.sourceTabId === tabId || s.targets.some((t) => t.tabId === tabId))
}
export async function transferSourceChanged(tabId: number) {
  await serial(async () => {
    const s = await session()
    if (s.sourceTabId === tabId && !s.sourceChanged) { s.sourceChanged = true; await persist(s) }
  })
}
export function transferTabReady(tabId: number) {
  void serial(async () => {
    const s = await session()
    if (s.frozen || running) return
    const target = s.targets.find((t) => t.tabId === tabId)
    if (target && !target.plan) { await prepareTarget(s, target); aggregate(s); await persist(s) }
  }).catch(() => undefined)
}
