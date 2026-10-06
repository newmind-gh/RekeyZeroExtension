import { useEffect, useRef, useState } from "react"
import { Settings } from "lucide-react"
import { worker } from "./client"
import type { Command, MappingProfile, Session } from "../transfer/types"
import type { PersonalAiSettingsView } from "../shared/types"
import { successful } from "../transfer/planner"
import { PROFILE_REVISION_KEY } from "../transfer/store"
import { PrepareSourceCard } from "./PrepareSourceCard"
import { isBlankSourceValue } from "../personal/source-prepare/source-value-normalizer"

const PROFILE_FIELD_NOT_APPLICABLE = "__rekeyzero_not_applicable__"

async function command<T = Session>(value: Command): Promise<T> {
  const reply = await chrome.runtime.sendMessage({ type: "TRANSFER", command: value })
  if (!reply?.ok) throw new Error(reply?.error || "Batch operation failed")
  return reply.data as T
}
export function TransferPanel() {
  const [session, setSession] = useState<Session>()
  const [tabs, setTabs] = useState<chrome.tabs.Tab[]>([])
  const [sourceTabId, setSourceTabId] = useState<number>()
  const sourceTabIdRef = useRef<number | undefined>(undefined)
  const knownTabIdsRef = useRef(new Set<number>())
  const [selected, setSelected] = useState<number[]>([])
  const [profileError, setProfileError] = useState("")
  const [aiFillError, setAiFillError] = useState("")
  const [busy, setBusy] = useState(false)
  const [profiles, setProfiles] = useState<MappingProfile[]>([])
  const [fillSetups, setFillSetups] = useState<MappingProfile[]>([])
  const [selectedProfileId, setSelectedProfileId] = useState("")
  const [selectedFillSetupId, setSelectedFillSetupId] = useState("")
  const [creatingProfile, setCreatingProfile] = useState(false)
  const [nonAiOpen, setNonAiOpen] = useState(false)
  const [editingProfile, setEditingProfile] = useState(false)
  const [profileName, setProfileName] = useState("")
  const [profileDraft, setProfileDraft] = useState<Record<string, Record<string, { sourceInstanceKey?: string; existingValuePolicy: "blank_only" | "overwrite" | "skip" }>>>({})
  const [profileValidationAttempted, setProfileValidationAttempted] = useState(false)
  const [fillSetupName, setFillSetupName] = useState("")
  const [fillSetupSourceUrl, setFillSetupSourceUrl] = useState("")
  const [fillSetupTargetUrls, setFillSetupTargetUrls] = useState("")
  const [creatingFillSetup, setCreatingFillSetup] = useState(false)
  const [editingFillSetupId, setEditingFillSetupId] = useState("")
  const [fillSetupStatus, setFillSetupStatus] = useState("")
  const [localAi, setLocalAi] = useState<PersonalAiSettingsView | null>(null)
  const [apiProviderId, setApiProviderId] = useState("")
  const [apiModelName, setApiModelName] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [apiSettingsOpen, setApiSettingsOpen] = useState(false)
  const syncApiDraft = (settings: PersonalAiSettingsView, preferredId?: string | null) => {
    const models = settings.apiModels ?? []
    const selected = models.find((model) => model.id === preferredId)
      ?? models.find((model) => model.id === settings.apiModelId)
      ?? models[0]
    if (!selected) return
    setApiProviderId(selected.id)
    setApiModelName(selected.model)
    setApiKey("")
  }
  const run = async (value: Command, section: "profile" | "ai-fill" = "profile") => {
    const setSectionError = section === "ai-fill" ? setAiFillError : setProfileError
    setBusy(true); setSectionError("")
    try { setSession(await command(value)) }
    catch (caught) { setSectionError(caught instanceof Error ? caught.message : "Batch operation failed") }
    finally { setBusy(false) }
  }
  useEffect(() => {
    void (async () => {
      try {
        let current = await command({ type: "GET_TRANSFER" })
        const openTabs = (await chrome.tabs.query({})).filter((tab) => tab.id && tab.url && /^https?:/.test(tab.url))
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
        const initialSourceId = (openTabs.some((tab) => tab.id === current.sourceTabId) ? current.sourceTabId : undefined) ??
          (activeTab?.id && openTabs.some((tab) => tab.id === activeTab.id) ? activeTab.id : openTabs[0]?.id)
        knownTabIdsRef.current = new Set(openTabs.map((tab) => tab.id!))
        sourceTabIdRef.current = initialSourceId
        setTabs(openTabs)
        setSourceTabId(initialSourceId)
        setSelected(openTabs.filter((tab) => tab.id !== initialSourceId).map((tab) => tab.id!))
        if (!current.source && !current.frozen && initialSourceId) {
          const sourceTab = openTabs.find((tab) => tab.id === initialSourceId)
          if (sourceTab?.url && await chrome.permissions.contains({ origins: [`${new URL(sourceTab.url).origin}/*`] })) {
            current = await command({ type: "SET_SOURCE", tabId: initialSourceId })
          }
        }
        setSession(current)
        const availableProfiles = await command<MappingProfile[]>({ type: "GET_MAPPING_PROFILES" })
        const standardProfiles = availableProfiles.filter((profile) => profile.kind !== "ai_fill_setup")
        const availableSetups = availableProfiles.filter((profile) => profile.kind === "ai_fill_setup")
        setProfiles(standardProfiles)
        setFillSetups(availableSetups)
        setSelectedProfileId(current.mappingProfileId && standardProfiles.some((profile) => profile.id === current.mappingProfileId)
          ? current.mappingProfileId
          : standardProfiles[0]?.id ?? "")
        setSelectedFillSetupId(current.mappingProfileId && availableSetups.some((profile) => profile.id === current.mappingProfileId)
          ? current.mappingProfileId
          : availableSetups[0]?.id ?? "")
        const settings = await worker<PersonalAiSettingsView>({ type: "PERSONAL_GET_AI_SETTINGS" })
        setLocalAi(settings)
        syncApiDraft(settings)
        setApiSettingsOpen(!settings.apiModels?.some((model) => model.status === "ready"))
      } catch (caught) { setProfileError(caught instanceof Error ? caught.message : "Unable to list open tabs") }
    })()
    const change = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && changes[PROFILE_REVISION_KEY]?.newValue) {
        void command<MappingProfile[]>({ type: "GET_MAPPING_PROFILES" }).then((availableProfiles) => {
          const standardProfiles = availableProfiles.filter((profile) => profile.kind !== "ai_fill_setup")
          const availableSetups = availableProfiles.filter((profile) => profile.kind === "ai_fill_setup")
          setProfiles(standardProfiles)
          setFillSetups(availableSetups)
          setSelectedProfileId((selected) => standardProfiles.some((profile) => profile.id === selected)
            ? selected
            : standardProfiles[0]?.id ?? "")
          setSelectedFillSetupId((selected) => availableSetups.some((profile) => profile.id === selected)
            ? selected
            : availableSetups[0]?.id ?? "")
        }).catch((caught) => setProfileError(caught instanceof Error ? caught.message : "Unable to refresh Mapping Profiles"))
        return
      }
      if (area !== "session" || !changes.rekeyzeroTransfer?.newValue) return
      const next = changes.rekeyzeroTransfer.newValue as Session
      setSession(next)
      if (next.sourceTabId && next.sourceTabId !== sourceTabIdRef.current) {
        sourceTabIdRef.current = next.sourceTabId
        setSourceTabId(next.sourceTabId)
        setSelected((ids) => ids.filter((id) => id !== next.sourceTabId))
      }
    }
    chrome.storage.onChanged.addListener(change)
    const refreshOpenTabs = () => {
      void (async () => {
        const openTabs = (await chrome.tabs.query({})).filter((tab) => tab.id && tab.url && /^https?:/.test(tab.url))
        const previousIds = knownTabIdsRef.current
        const openIds = new Set(openTabs.map((tab) => tab.id!))
        let sourceId = sourceTabIdRef.current
        if (!sourceId || !openIds.has(sourceId)) {
          const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
          sourceId = activeTab?.id && openIds.has(activeTab.id) ? activeTab.id : openTabs[0]?.id
          sourceTabIdRef.current = sourceId
          setSourceTabId(sourceId)
          setSelected(openTabs.filter((tab) => tab.id !== sourceId).map((tab) => tab.id!))
        } else {
          setSelected((ids) => {
            const next = new Set(ids.filter((id) => openIds.has(id) && id !== sourceId))
            for (const tab of openTabs) if (!previousIds.has(tab.id!) && tab.id !== sourceId) next.add(tab.id!)
            return [...next]
          })
        }
        knownTabIdsRef.current = openIds
        setTabs(openTabs)
      })().catch(() => undefined)
    }
    chrome.tabs.onCreated.addListener(refreshOpenTabs)
    chrome.tabs.onRemoved.addListener(refreshOpenTabs)
    chrome.tabs.onUpdated.addListener(refreshOpenTabs)
    chrome.tabs.onAttached.addListener(refreshOpenTabs)
    chrome.tabs.onDetached.addListener(refreshOpenTabs)
    chrome.windows.onCreated.addListener(refreshOpenTabs)
    chrome.windows.onRemoved.addListener(refreshOpenTabs)
    const timer = setInterval(() => { void refresh().catch(() => undefined) }, 5000)
    async function refresh() {
      const reply = await chrome.runtime.sendMessage({ type: "TRANSFER", command: { type: "GET_TRANSFER" } })
      if (reply?.ok) setSession(reply.data)
    }
    return () => {
      chrome.storage.onChanged.removeListener(change)
      chrome.tabs.onCreated.removeListener(refreshOpenTabs)
      chrome.tabs.onRemoved.removeListener(refreshOpenTabs)
      chrome.tabs.onUpdated.removeListener(refreshOpenTabs)
      chrome.tabs.onAttached.removeListener(refreshOpenTabs)
      chrome.tabs.onDetached.removeListener(refreshOpenTabs)
      chrome.windows.onCreated.removeListener(refreshOpenTabs)
      chrome.windows.onRemoved.removeListener(refreshOpenTabs)
      clearInterval(timer)
    }
  }, [])
  const refreshTabs = async () => {
    try {
      const openTabs = (await chrome.tabs.query({})).filter((tab) => tab.id && tab.url && /^https?:/.test(tab.url))
      knownTabIdsRef.current = new Set(openTabs.map((tab) => tab.id!))
      setTabs(openTabs)
      setSelected((ids) => ids.filter((id) => id !== sourceTabId && openTabs.some((tab) => tab.id === id)))
    } catch (caught) { setProfileError(caught instanceof Error ? caught.message : "Unable to refresh open tabs") }
  }
  const observeSource = async (tabId: number) => {
    const tab = tabs.find((candidate) => candidate.id === tabId)
    if (!tab?.url || !/^https?:/.test(tab.url)) throw new Error("Select an available source webpage")
    if (!await chrome.permissions.request({ origins: [`${new URL(tab.url).origin}/*`] })) throw new Error("Source access was declined")
    let current = await command<Session>({ type: "GET_TRANSFER" })
    const group = current.sourceTabId === tabId ? current.source?.group : undefined
    const duplicateTarget = current.targets.find((target) => target.tabId === tabId)
    if (duplicateTarget) current = await command({ type: "REMOVE_TARGET", targetId: duplicateTarget.id })
    current = await command({ type: "SET_SOURCE", tabId, group })
    setSession(current)
    sourceTabIdRef.current = tabId
    setSourceTabId(tabId)
    setSelected((ids) => ids.filter((id) => id !== tabId))
  }
  const selectSource = async (tabId: number, section: "profile" | "ai-fill" = "profile") => {
    const setError = section === "ai-fill" ? setAiFillError : setProfileError
    setBusy(true); setError("")
    try {
      await observeSource(tabId)
      setSelected(tabs.filter((candidate) => candidate.id !== tabId).map((candidate) => candidate.id!))
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to select the source tab") }
    finally { setBusy(false) }
  }
  const prepareSelectedTabs = async () => {
    setBusy(true); setProfileError("")
    try {
      const sourceTab = tabs.find((tab) => tab.id === sourceTabId)
      if (!sourceTab?.id || !sourceTab.url) throw new Error("Select a source tab")
      const targetTabs = tabs.filter((tab) => tab.id !== sourceTab.id && selected.includes(tab.id!))
      if (!targetTabs.length) throw new Error("Select at least one target tab")
      const origins = [...new Set([sourceTab, ...targetTabs].map((tab) => new URL(tab.url!).origin))]
      if (!await chrome.permissions.request({ origins: origins.map((origin) => `${origin}/*`) })) throw new Error("Website access was declined")
      let current: Session = session ?? await command<Session>({ type: "GET_TRANSFER" })
      if (current.sourceTabId !== sourceTab.id || !current.source) {
        const duplicateTarget = current.targets.find((target) => target.tabId === sourceTab.id)
        if (duplicateTarget) current = await command({ type: "REMOVE_TARGET", targetId: duplicateTarget.id })
        current = await command({ type: "SET_SOURCE", tabId: sourceTab.id })
      }
      for (const target of current.targets.filter((candidate) => !selected.includes(candidate.tabId))) {
        current = await command({ type: "REMOVE_TARGET", targetId: target.id })
      }
      current = await command({ type: "ADD_TARGETS", tabIds: targetTabs.map((tab) => tab.id!) })
      setSession(current)
      beginProfileEditor(current)
    } catch (caught) { setProfileError(caught instanceof Error ? caught.message : "Unable to prepare selected tabs") }
    finally { setBusy(false) }
  }
  const prepareAndFill = async (profileId = selectedProfileId) => {
    const profile = [...profiles, ...fillSetups].find((candidate) => candidate.id === profileId)
    if (!profile) return
    const setSectionError = profile.kind === "ai_fill_setup" ? setAiFillError : setProfileError
    setBusy(true); setSectionError("")
    try {
      const origins = [...new Set([profile.source.origin, ...profile.targets.map((target) => target.origin)])]
      if (!await chrome.permissions.request({ origins: origins.map((origin) => `${origin}/*`) })) throw new Error("Website access was declined")
      const prepared = await command<Session>({ type: "USE_MAPPING_PROFILE", profileId: profile.id })
      setSession(prepared)
      sourceTabIdRef.current = prepared.sourceTabId
      setSourceTabId(prepared.sourceTabId)
      setSelected(prepared.targets.map((target) => target.tabId))
      if (!prepared.profileDrift) setSession(await command<Session>({ type: "RUN_TRANSFER" }))
    } catch (caught) { setSectionError(caught instanceof Error ? caught.message : "Unable to prepare and fill with the Mapping Profile") }
    finally { setBusy(false) }
  }
  const waitForTab = async (tab: chrome.tabs.Tab): Promise<chrome.tabs.Tab> => {
    if (tab.status === "complete") return tab
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { chrome.tabs.onUpdated.removeListener(updated); reject(new Error("A URL did not finish loading")) }, 20_000)
      const updated = (tabId: number, info: chrome.tabs.OnUpdatedInfo, next: chrome.tabs.Tab) => {
        if (tabId !== tab.id || info.status !== "complete") return
        clearTimeout(timeout); chrome.tabs.onUpdated.removeListener(updated); resolve(next)
      }
      chrome.tabs.onUpdated.addListener(updated)
    })
  }
  const resolveFillSetupUrl = async (raw: string): Promise<chrome.tabs.Tab> => {
    const url = new URL(raw.trim())
    if (url.username || url.password || !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))) {
      throw new Error("ZeroKey Profile URLs must use HTTPS, except localhost")
    }
    const openTabs = await chrome.tabs.query({})
    const existing = openTabs.find((tab) => {
      try { return Boolean(tab.url && new URL(tab.url).href === url.href) } catch { return false }
    })
    return waitForTab(existing ?? await chrome.tabs.create({ url: url.href, active: false }))
  }
  const saveFillSetup = async () => {
    setBusy(true); setAiFillError(""); setFillSetupStatus("Connecting to the selected AI model...")
    try {
      if (!fillSetupName.trim()) throw new Error("Enter a name for the ZeroKey Profile")
      const sourceTab = fillSetupSourceUrl.trim()
        ? await resolveFillSetupUrl(fillSetupSourceUrl)
        : tabs.find((tab) => tab.id === sourceTabId)
      if (!sourceTab?.id || !sourceTab.url) throw new Error("Select a source tab or enter a source URL")
      const targetIds = new Set(selected.filter((id) => id !== sourceTab.id))
      for (const url of fillSetupTargetUrls.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
        const tab = await resolveFillSetupUrl(url)
        if (tab.id && tab.id !== sourceTab.id) targetIds.add(tab.id)
      }
      const openTabs = (await chrome.tabs.query({})).filter((tab) => tab.id && tab.url && /^https?:/.test(tab.url))
      const targetTabs = openTabs.filter((tab) => targetIds.has(tab.id!))
      if (!targetTabs.length) throw new Error("Select at least one target tab or enter a target URL")
      const origins = [...new Set([sourceTab, ...targetTabs].map((tab) => new URL(tab.url!).origin))]
      if (!await chrome.permissions.request({ origins: origins.map((origin) => `${origin}/*`) })) throw new Error("Website access was declined")
      let prepared = await command<Session>({ type: "RESET_TRANSFER" })
      prepared = await command<Session>({ type: "SET_SOURCE", tabId: sourceTab.id })
      prepared = await command<Session>({ type: "ADD_TARGETS", tabIds: targetTabs.map((tab) => tab.id!) })
      prepared = await worker<Session>({ type: "PERSONAL_AI_MATCH_TRANSFER" })
      const mappedCount = prepared.targets.reduce((count, target) => count + (target.plan?.actions.filter((action) => action.sourceInstanceKey).length ?? 0), 0)
      if (!mappedCount) throw new Error("The selected AI model did not find any validated field matches")
      const saved = await command<MappingProfile>({
        type: "SAVE_MAPPING_PROFILE",
        profileId: editingFillSetupId || undefined,
        kind: "ai_fill_setup",
        name: fillSetupName,
        targets: prepared.targets.map((target) => ({ targetId: target.id, mappings: (target.plan?.actions ?? []).map((action) => ({
          targetInstanceKey: action.field.instanceKey,
          sourceInstanceKey: action.sourceInstanceKey,
          existingValuePolicy: action.sourceInstanceKey ? "blank_only" : "skip",
        })) })),
      })
      const availableProfiles = await command<MappingProfile[]>({ type: "GET_MAPPING_PROFILES" })
      await command<Session>({ type: "RESET_TRANSFER" })
      setProfiles(availableProfiles.filter((profile) => profile.kind !== "ai_fill_setup"))
      setFillSetups(availableProfiles.filter((profile) => profile.kind === "ai_fill_setup"))
      setSelectedFillSetupId(saved.id); setCreatingFillSetup(false); setEditingFillSetupId("")
      setTabs(openTabs); sourceTabIdRef.current = sourceTab.id; setSourceTabId(sourceTab.id); setSelected([...targetIds])
      setFillSetupStatus(`Saved “${saved.name}” with ${mappedCount} validated field ${mappedCount === 1 ? "match" : "matches"}.`)
    } catch (caught) {
      setAiFillError(caught instanceof Error ? caught.message : "Unable to create the ZeroKey Profile")
      setFillSetupStatus("")
    }
    finally { setBusy(false) }
  }
  const startCreateFillSetup = () => {
    setCreatingFillSetup(true); setEditingFillSetupId(""); setFillSetupName("AI ZeroKey Profile")
    setFillSetupSourceUrl(""); setFillSetupTargetUrls(""); setFillSetupStatus(""); setAiFillError("")
    void refreshTabs()
  }
  const openFillSetup = () => {
    const setup = fillSetups.find((candidate) => candidate.id === selectedFillSetupId)
    if (!setup) return
    const sourceTab = tabs.find((tab) => tab.title === setup.source.title)
    const targetTitles = new Set(setup.targets.map((target) => target.title))
    setCreatingFillSetup(true); setEditingFillSetupId(setup.id); setFillSetupName(setup.name)
    setFillSetupSourceUrl(""); setFillSetupTargetUrls(""); setFillSetupStatus(""); setAiFillError("")
    if (sourceTab?.id) { sourceTabIdRef.current = sourceTab.id; setSourceTabId(sourceTab.id) }
    setSelected(tabs.filter((tab) => tab.id !== sourceTab?.id && targetTitles.has(tab.title ?? "")).map((tab) => tab.id!))
  }
  const setAiModelEnabled = async (modelId: string, enabled: boolean) => {
    const isApiModel = Boolean(localAi?.apiModels?.some((model) => model.id === modelId))
    setBusy(true); setAiFillError(""); setFillSetupStatus(enabled ? (isApiModel ? "Checking API model…" : "Downloading and loading Local AI…") : "")
    if (localAi) setLocalAi({ ...localAi, selectedModelId: enabled ? modelId : null, localModelId: modelId, localModelEnabled: enabled, localModelStatus: enabled ? "loading" : localAi.localModelStatus })
    try {
      const updated = await worker<PersonalAiSettingsView>({ type: "PERSONAL_SET_LOCAL_AI_ENABLED", enabled, modelId })
      setLocalAi(updated)
      if (isApiModel) syncApiDraft(updated, modelId)
      const selectedModel = updated.localModels.find((model) => model.id === modelId)
      setFillSetupStatus(enabled
        ? (isApiModel
            ? `${selectedModel?.displayName ?? "API model"} is selected and ready.`
            : `${selectedModel?.modelArtifact ?? "Local AI"} is downloaded, enabled, and ready.`)
        : "The AI model is disabled.")
    } catch (caught) {
      setLocalAi(await worker<PersonalAiSettingsView>({ type: "PERSONAL_GET_AI_SETTINGS" }).catch(() => localAi))
      setAiFillError(caught instanceof Error ? caught.message : "Unable to update the AI model")
      setFillSetupStatus("")
    } finally { setBusy(false) }
  }
  const selectApiProvider = (modelId: string) => {
    const selected = localAi?.apiModels?.find((model) => model.id === modelId)
    if (!selected) return
    setApiProviderId(selected.id)
    setApiModelName(selected.model)
    setApiKey("")
    setAiFillError("")
  }
  const selectAiModel = (modelId: string) => {
    const apiModel = localAi?.apiModels?.find((model) => model.id === modelId)
    if (!apiModel) {
      void setAiModelEnabled(modelId, true)
      return
    }
    selectApiProvider(modelId)
    setApiSettingsOpen(true)
    setLocalAi((current) => current ? { ...current, selectedModelId: modelId } : current)
    if (apiModel.status === "ready") void setAiModelEnabled(modelId, true)
  }
  const saveApiProvider = async () => {
    const selected = localAi?.apiModels?.find((model) => model.id === apiProviderId)
    if (!selected) return
    if (!selected.models.some((model) => model.id === apiModelName)) {
      setAiFillError(`Choose a supported ${selected.displayName.replace(/ · API$/, "")} model`)
      return
    }
    if (!apiKey.trim() && !selected.hasKey) {
      setAiFillError(`Enter the ${selected.displayName.replace(/ · API$/, "")} API key`)
      return
    }
    setBusy(true); setAiFillError(""); setFillSetupStatus("Requesting access to the provider…")
    try {
      const granted = await chrome.permissions.request({ origins: [`${new URL(selected.origin).origin}/*`] })
      if (!granted) throw new Error(`${selected.displayName} access was declined`)
      const updated = await worker<PersonalAiSettingsView>({
        type: "PERSONAL_CONFIGURE_API_MODEL",
        modelId: selected.id,
        model: apiModelName.trim(),
        rememberKey: false,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      })
      setLocalAi(updated)
      syncApiDraft(updated, selected.id)
      setFillSetupStatus(`${selected.displayName} is configured and selected.`)
    } catch (caught) {
      setAiFillError(caught instanceof Error ? caught.message : "Unable to save the API provider")
      setFillSetupStatus("")
    } finally { setBusy(false) }
  }
  const resetApiProvider = async () => {
    const selected = localAi?.apiModels?.find((model) => model.id === apiProviderId)
    if (!selected || !confirm(`Reset the saved ${selected.displayName} configuration and API key?`)) return
    setBusy(true); setAiFillError(""); setFillSetupStatus("")
    try {
      const updated = await worker<PersonalAiSettingsView>({ type: "PERSONAL_REMOVE_API_MODEL", modelId: selected.id })
      setLocalAi({
        ...updated,
        selectedModelId: selected.id,
        localModelId: selected.id,
        localModelEnabled: false,
      })
      syncApiDraft(updated, selected.id)
      setFillSetupStatus(`${selected.displayName} was reset to its default model and its API key was cleared.`)
    } catch (caught) {
      setAiFillError(caught instanceof Error ? caught.message : "Unable to reset the API provider")
    } finally { setBusy(false) }
  }
  const beginProfileEditor = (current: Session = session!, name = "") => {
    if (!current?.source || !current.targets.some((target) => target.plan)) return
    const draft: typeof profileDraft = {}
    for (const target of current.targets) {
      draft[target.id] = {}
      for (const action of target.plan?.actions ?? []) {
        const decision = target.decisions[action.field.instanceKey]
        draft[target.id][action.field.instanceKey] = {
          sourceInstanceKey: decision?.sourceInstanceKey ?? action.sourceInstanceKey,
          existingValuePolicy: decision?.mode === "overwrite" ? "overwrite" : decision?.mode === "skip" ? "skip" : "blank_only",
        }
      }
    }
    setProfileDraft(draft)
    setProfileName(name || `${current.source.title} transfer`)
    setProfileValidationAttempted(false)
    setEditingProfile(true)
  }
  const startCreateProfile = async () => {
    setBusy(true); setProfileError("")
    try {
      const reset = await command<Session>({ type: "RESET_TRANSFER" })
      setSession(reset)
      setSelectedProfileId("")
      setCreatingProfile(true)
      setEditingProfile(false)
      setProfileName("")
      setProfileDraft({})
      setProfileValidationAttempted(false)
    } catch (caught) { setProfileError(caught instanceof Error ? caught.message : "Unable to start a new Mapping Profile") }
    finally { setBusy(false) }
  }
  const openSelectedProfile = async () => {
    const profile = profiles.find((candidate) => candidate.id === selectedProfileId)
    if (!profile) return
    setBusy(true); setProfileError("")
    try {
      const origins = [...new Set([profile.source.origin, ...profile.targets.map((target) => target.origin)])]
      if (!await chrome.permissions.request({ origins: origins.map((origin) => `${origin}/*`) })) throw new Error("Website access was declined")
      const prepared = await command<Session>({ type: "OPEN_MAPPING_PROFILE", profileId: profile.id })
      setSession(prepared)
      sourceTabIdRef.current = prepared.sourceTabId
      setSourceTabId(prepared.sourceTabId)
      setSelected(prepared.targets.map((target) => target.tabId))
      beginProfileEditor(prepared, profile.name)
      setCreatingProfile(true)
    } catch (caught) { setProfileError(caught instanceof Error ? caught.message : "Unable to open the selected Mapping Profile") }
    finally { setBusy(false) }
  }
  const cancelCreateProfile = () => {
    setCreatingProfile(false)
    setEditingProfile(false)
    setProfileName("")
    setProfileDraft({})
    setProfileValidationAttempted(false)
    setSelectedProfileId(selectedProfileId || profiles[0]?.id || "")
  }
  const updateProfileField = (targetId: string, fieldKey: string, patch: Partial<{ sourceInstanceKey?: string; existingValuePolicy: "blank_only" | "overwrite" | "skip" }>) => {
    setProfileDraft((current) => ({
      ...current,
      [targetId]: {
        ...current[targetId],
        [fieldKey]: { ...(current[targetId]?.[fieldKey] ?? { existingValuePolicy: "blank_only" }), ...patch },
      },
    }))
  }
  const saveProfile = async () => {
    if (!session) return
    const hasIncompleteFields = session.targets.some((target) => (target.plan?.actions ?? []).some((action) => {
      const configured = profileDraft[target.id]?.[action.field.instanceKey] ?? { existingValuePolicy: "skip" as const }
      return configured.existingValuePolicy !== "skip" && !session.source?.fields.some((field) => field.instanceKey === configured.sourceInstanceKey)
    }))
    if (hasIncompleteFields) {
      setProfileValidationAttempted(true)
      setProfileError("Complete or skip every target field in the profile")
      requestAnimationFrame(() => document.querySelector(".profile-field--invalid")?.scrollIntoView({ behavior: "smooth", block: "center" }))
      return
    }
    setBusy(true); setProfileError("")
    try {
      const saved = await command<MappingProfile>({
        type: "SAVE_MAPPING_PROFILE",
        profileId: selectedProfileId || undefined,
        name: profileName,
        targets: session.targets.map((target) => ({
          targetId: target.id,
          mappings: (target.plan?.actions ?? []).map((action) => {
            const configured = profileDraft[target.id]?.[action.field.instanceKey] ?? { existingValuePolicy: "skip" as const }
            return { targetInstanceKey: action.field.instanceKey, ...configured }
          }),
        })),
      })
      const availableProfiles = await command<MappingProfile[]>({ type: "GET_MAPPING_PROFILES" })
      const reset = await command<Session>({ type: "RESET_TRANSFER" })
      setProfiles(availableProfiles.filter((profile) => profile.kind !== "ai_fill_setup"))
      setFillSetups(availableProfiles.filter((profile) => profile.kind === "ai_fill_setup"))
      setSession(reset)
      setSelectedProfileId(saved.id)
      setCreatingProfile(false)
      setEditingProfile(false)
      setProfileValidationAttempted(false)
    } catch (caught) { setProfileError(caught instanceof Error ? caught.message : "Unable to save the Mapping Profile") }
    finally { setBusy(false) }
  }
  const removeProfile = async () => {
    if (!selectedProfileId) return
    setBusy(true); setProfileError("")
    try {
      const remaining = await command<MappingProfile[]>({ type: "DELETE_MAPPING_PROFILE", profileId: selectedProfileId })
      const reset = await command<Session>({ type: "RESET_TRANSFER" })
      const standardProfiles = remaining.filter((profile) => profile.kind !== "ai_fill_setup")
      setProfiles(standardProfiles)
      setFillSetups(remaining.filter((profile) => profile.kind === "ai_fill_setup"))
      setSession(reset)
      setSelectedProfileId(standardProfiles[0]?.id ?? "")
      setCreatingProfile(false)
      setEditingProfile(false)
      setProfileName("")
      setProfileDraft({})
      setProfileValidationAttempted(false)
    } catch (caught) { setProfileError(caught instanceof Error ? caught.message : "Unable to delete the Mapping Profile") }
    finally { setBusy(false) }
  }
  const frozen = session?.frozen ?? false
  const running = session?.status === "running"
  const disabled = busy || running
  const preparedTargets = session?.targets.filter((target) => target.plan) ?? []
  const runnableTargets = preparedTargets.filter((target) => ["ready", "needs_input", "running"].includes(target.status))
  const readyCount = preparedTargets.reduce((count, target) => count + target.plan!.actions.filter((action) => ["ready", "unknown"].includes(action.status)).length, 0)
  const pending = session?.targets.reduce((n, t) => n + (t.plan?.actions.filter((a) => !successful(a.status) && a.status !== "ready" && a.status !== "skipped" &&
    !(a.status === "preserved_existing" && t.decisions[a.field.instanceKey]?.mode === "preserve")).length ?? 0), 0) ?? 0
  const profilePrepared = Boolean(session?.mappingProfileId && [selectedProfileId, selectedFillSetupId].includes(session.mappingProfileId) && session.targets.length)
  const activeSessionIsAiFill = Boolean(
    session?.mappingProfileId
    && fillSetups.some((setup) => setup.id === session.mappingProfileId),
  )
  const profileSessionError = activeSessionIsAiFill ? "" : session?.error ?? ""
  const aiFillSessionError = activeSessionIsAiFill ? session?.error ?? "" : ""
  const selectedApiModel = localAi?.apiModels?.find((model) => model.id === localAi.selectedModelId)
  const selectedApiOption = selectedApiModel?.models.find((model) => model.id === apiModelName)
  const selectedAiReady = Boolean(localAi?.selectedModelId && localAi.selectedModelId === localAi.localModelId
    && localAi.localModelEnabled && localAi.localModelStatus === "ready")
  return <main className="transfer-panel">
    {!creatingProfile && <section className="card ai-fill-setup">
    <header className="transfer-header">
      <h2>AI ZeroKey Profile</h2>
      <button
        type="button"
        className="workspace-settings"
        aria-label="Open RekeyZero Admin"
        title="Open RekeyZero Admin"
        onClick={() => void chrome.runtime.openOptionsPage().catch((caught) => setProfileError(caught instanceof Error ? caught.message : "Unable to open RekeyZero Admin"))}
      ><Settings aria-hidden="true" size={18} /></button>
    </header>
      {aiFillError && <div className="error" role="alert">{aiFillError}</div>}
      {!aiFillError && aiFillSessionError && <div className="error" role="alert">{aiFillSessionError}</div>}
      {fillSetupStatus && <p className="fill-setup-status" role="status">{fillSetupStatus}</p>}
      <select
        aria-label="AI Model"
        value={localAi?.selectedModelId ?? ""}
        disabled={busy || !localAi}
        onChange={(event) => { if (event.target.value) selectAiModel(event.target.value) }}
      >
        <option value="" disabled>Select AI Model</option>
        {(["Local", "API"] as const).map((group) => <optgroup key={group} label={group}>
        {localAi?.localModels.filter((model) => Boolean(localAi.apiModels?.some((api) => api.id === model.id)) === (group === "API")).map((model) => {
          const apiModel = localAi.apiModels?.find((candidate) => candidate.id === model.id)
          const isApiModel = Boolean(apiModel)
          const isExternalLocalRuntime = !isApiModel && model.estimatedDownloadBytes === 0 && model.estimatedPeakMemoryMb === 0
          const status = isApiModel
            ? (model.status === "ready" ? "Ready" : "Not ready")
            : isExternalLocalRuntime
              ? (model.status === "ready" ? "" : "Not ready")
              : model.status === "loading"
                ? "Downloading…"
                : model.status === "ready"
                  ? "Downloaded"
                  : model.status === "unsupported_device"
                    ? "Not supported"
                    : model.status === "failed"
                      ? "Not ready"
                      : "Not downloaded"
          return <option key={model.id} value={model.id}>
            {model.displayName}{model.experimental ? " · Experimental" : ""}{status ? ` · ${status}` : ""}
          </option>
        })}</optgroup>)}
      </select>
      {selectedApiModel && <details className="api-provider-config" open={apiSettingsOpen} onToggle={(event) => setApiSettingsOpen(event.currentTarget.open)}>
        <summary>API settings</summary>
        <label>{selectedApiModel.displayName} model<select aria-label={`${selectedApiModel.displayName} model`} value={apiModelName} disabled={busy} onChange={(event) => setApiModelName(event.target.value)}>
          {selectedApiModel.models.map((model) => <option key={model.id} value={model.id}>
            {model.displayName}{model.costTier === "free" ? " · Free tier" : model.costTier === "lowest_cost" ? " · Lowest cost" : ""}{model.recommended ? " · Recommended" : ""}
          </option>)}
        </select></label>
        {selectedApiOption?.recommended && <p className="help">{selectedApiModel.defaultReason === "free_tier" ? "Free tier" : "Lowest cost"} · Recommended</p>}
        <label>{selectedApiModel.displayName} key<input aria-label={`${selectedApiModel.displayName} key`} type="password" autoComplete="off" value={apiKey} disabled={busy} placeholder={selectedApiModel.hasKey ? "Leave blank to keep the saved key" : "Enter API key"} onChange={(event) => setApiKey(event.target.value)} /></label>
        <p className="help">The key stays only in extension session storage and must be entered again after the browser restarts.</p>
        <div className="api-provider-actions">
          <button disabled={busy || !apiProviderId || !apiModelName.trim()} onClick={() => void saveApiProvider()}>Save and select</button>
          <button className="secondary" disabled={busy || !selectedApiModel.configured} onClick={() => void resetApiProvider()}>Reset</button>
        </div>
      </details>}
      <PrepareSourceCard tabId={sourceTabId} busy={busy || frozen} onBusy={setBusy}
        aiReady={selectedAiReady}
        onObserve={async () => {
          if (sourceTabId === undefined) throw new Error("Select a source tab")
          await observeSource(sourceTabId)
        }}
        onComplete={async () => setSession(await command({ type: "GET_TRANSFER" }))}>
        <div className="current-source">
          <label>Source page<select aria-label="Current source tab" value={sourceTabId ?? ""} disabled={busy || frozen}
            onFocus={() => void refreshTabs()}
            onChange={(event) => {
              const id = Number(event.target.value)
              sourceTabIdRef.current = id; setSourceTabId(id)
              setSelected((ids) => ids.filter((tabId) => tabId !== id))
            }}>
            <option value="" disabled>Select a source tab</option>{tabs.map((tab) => <option key={tab.id} value={tab.id}>{tab.title || new URL(tab.url!).hostname} · {tab.url}</option>)}
          </select></label>
          {session?.sourceTabId === sourceTabId && session?.source && <>
            <p>{session.source.fields.length} fields · {session.source.fields.filter((field) => !isBlankSourceValue(field.value)).length} populated · {session.source.fields.filter((field) => isBlankSourceValue(field.value)).length} blank</p>
            {session.source.truncated && <p className="help">Partial scan: first 120 eligible controls only. Select a source section before preparing a larger form.</p>}
            {!frozen && session.source.availableGroups.length > 1 && <label>Source section<select aria-label="Prepare source section" value={session.source.group} disabled={busy}
              onChange={(event) => void run({ type: "SET_SOURCE", tabId: sourceTabId!, group: event.target.value }, "ai-fill")}>
              <option value="">All sections (up to 120 controls)</option>{session.source.availableGroups.map((group) => <option key={group} value={group}>{group}</option>)}
            </select></label>}
          </>}
        </div>
      </PrepareSourceCard>
      <h3>AI Mapping</h3>
      <select aria-label="AI Transfer Profile" value={selectedFillSetupId} disabled={disabled} onChange={(event) => setSelectedFillSetupId(event.target.value)}><option value="" disabled>{fillSetups.length ? "Select a profile" : "No profiles available"}</option>{fillSetups.map((setup) => <option key={setup.id} value={setup.id}>{setup.name}</option>)}</select>
      <button disabled={disabled} onClick={startCreateFillSetup}>Create Profile</button>
      <button disabled={disabled || !selectedFillSetupId} onClick={openFillSetup}>Open Profile</button>
      <div className="profile-run-actions"><button aria-label="Fill Targets" disabled={disabled || !selectedFillSetupId} onClick={() => void prepareAndFill(selectedFillSetupId)}>Fill Targets</button><button aria-label="Reset AI ZeroKey Profile" disabled={busy || !selectedFillSetupId} onClick={() => { setFillSetupStatus("Active fill reset. The saved ZeroKey Profile is unchanged."); void run({ type: "RESET_TRANSFER" }, "ai-fill") }}>Reset</button></div>
      {creatingFillSetup && <div className="fill-setup-editor"><h3>{editingFillSetupId ? "Open Profile" : "Create Profile"}</h3>
        <label>Profile name<input placeholder="AI ZeroKey Profile" value={fillSetupName} onChange={(event) => setFillSetupName(event.target.value)} /></label>
        <label>Source tab<select aria-label="AI ZeroKey Profile source tab" value={sourceTabId ?? ""} disabled={disabled} onFocus={() => void refreshTabs()} onChange={(event) => { const id = Number(event.target.value); sourceTabIdRef.current = id; setSourceTabId(id); setSelected((current) => current.filter((tabId) => tabId !== id)) }}><option value="" disabled>Select a source tab</option>{tabs.map((tab) => <option key={tab.id} value={tab.id}>{tab.title || new URL(tab.url!).hostname} · {tab.url}</option>)}</select></label>
        <label>Or enter source URL<input type="url" placeholder="https://source.example/customer/123" value={fillSetupSourceUrl} onChange={(event) => setFillSetupSourceUrl(event.target.value)} /></label>
        <div className="section-title"><h3>Target tabs</h3><span>{selected.length} selected</span></div>
        <div className="transfer-tabs">{tabs.filter((tab) => tab.id !== sourceTabId).map((tab) => <label key={tab.id}><input type="checkbox" disabled={disabled} checked={selected.includes(tab.id!)} onChange={(event) => setSelected(event.target.checked ? [...new Set([...selected, tab.id!])] : selected.filter((id) => id !== tab.id))} /><span><strong>{tab.title || new URL(tab.url!).hostname}</strong><small>{tab.url}</small></span></label>)}</div>
        <label>Additional target URLs <small>One URL per line</small><textarea placeholder={"https://target-one.example/form\nhttps://target-two.example/form"} value={fillSetupTargetUrls} onChange={(event) => setFillSetupTargetUrls(event.target.value)} /></label>
        <button disabled={disabled || !fillSetupName.trim() || !selectedAiReady} onClick={() => void saveFillSetup()}>Save Profile</button>
        <button className="secondary" disabled={disabled} onClick={() => { setCreatingFillSetup(false); setEditingFillSetupId("") }}>Cancel</button>
      </div>}
    </section>}
    <details className="non-ai-profile" open={nonAiOpen || creatingProfile} onToggle={(event) => setNonAiOpen(event.currentTarget.open)}>
      <summary>Use Non-AI ZeroKey Profile</summary>
    <section className="card"><h2>ZeroKey Profile</h2>
      {(profileError || profileSessionError) && <div className="error" role="alert">{profileError || profileSessionError}</div>}
      {!creatingProfile && <>
      <select aria-label="Transfer Profile" value={selectedProfileId} disabled={disabled} onChange={(event) => setSelectedProfileId(event.target.value)}>
        <option value="" disabled>{profiles.length ? "Select a profile" : "No profiles available"}</option>
        {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
      </select>
      <button disabled={disabled} onClick={() => void startCreateProfile()}>Create Profile</button>
      <button disabled={disabled || !selectedProfileId} onClick={() => void openSelectedProfile()}>Open Profile</button>
      <div className="profile-run-actions">
        <button disabled={disabled || !selectedProfileId} onClick={() => void prepareAndFill()}>Fill</button>
        <button disabled={busy || !preparedTargets.length} onClick={() => void run({ type: "RESET_TRANSFER" })}>Reset</button>
      </div>
      </>}
    </section>
    {creatingProfile && <>
    <section className="card"><h2>Source tab</h2>
      <label>Source<select aria-label="Source tab" value={sourceTabId ?? ""} disabled={disabled || editingProfile} onChange={(event) => void selectSource(Number(event.target.value))}>
        <option value="" disabled>Select a source tab</option>
        {tabs.map((tab) => <option key={tab.id} value={tab.id}>{tab.title || new URL(tab.url!).hostname}</option>)}
      </select></label>
      {session?.source ? <><strong>{session.source.title}</strong><p>{session.source.origin}</p>
        <p>Record: {session.source.identityEvidence.map((item) => `${item.label}: ${item.value}`).join(" · ") || (session.source.identityConfidence === "new_form" ? "New blank form" : "Identity not detected")}</p>
        <p>{session.source.fields.length} fields · {frozen ? "Frozen for this batch" : "Preview; current values checked at start"}</p>
        {session.sourceChanged && <p>{frozen ? "Source changed after start. This batch continues using its frozen values." : "Source values changed. They will be rechecked when you start."}</p>}
        {session.source.truncated && <p role="alert">Partial scan: {session.source.eligibleCount} eligible fields, first 120 read. This is not the whole page.</p>}
        {!session.frozen && !session.mappingProfileId && session.source.availableGroups.length > 0 && <label>Source section<select aria-label="Source section" value={session.source.group} disabled={disabled} onChange={(event) => void run({ type: "SET_SOURCE", tabId: session.sourceTabId!, group: event.target.value })}><option value="">All sections (up to 120 controls)</option>{session.source.availableGroups.map((group) => <option key={group} value={group}>{group}</option>)}</select></label>}
        <details><summary>View source data</summary>{session.source.fields.map((f) => <p key={f.id}>{f.group} / {f.label}: {f.display}</p>)}</details>
      </> : <p>The current browser tab is selected by default. Website access is requested when you select a source or prepare the tabs.</p>}
    </section>
    <section className="card"><div className="section-title"><h2>Target tabs</h2><span>{selected.length} selected</span></div>
      <div className="transfer-selection-actions">
        <button disabled={disabled || editingProfile} onClick={() => setSelected(tabs.filter((tab) => tab.id !== sourceTabId).map((tab) => tab.id!))}>Select all</button>
        <button disabled={disabled || editingProfile || !selected.length} onClick={() => setSelected([])}>Unselect all</button>
        <button disabled={disabled || editingProfile} onClick={() => void refreshTabs()}>Refresh tabs</button>
      </div>
      <div className="transfer-tabs">{tabs.filter((tab) => tab.id !== sourceTabId).map((tab) => <label key={tab.id}>
        <input type="checkbox" disabled={disabled || editingProfile} checked={selected.includes(tab.id!)} onChange={(event) => setSelected(event.target.checked ? [...new Set([...selected, tab.id!])] : selected.filter((id) => id !== tab.id))} />
        <span><strong>{tab.title || new URL(tab.url!).hostname}</strong><small>{tab.url}</small></span>
      </label>)}</div>
      {!editingProfile && <button disabled={disabled || !sourceTabId || !selected.length} onClick={() => void prepareSelectedTabs()}>Continue to Field Mappings</button>}
    </section>
    </>}
    {creatingProfile && <section className="card mapping-profile-editor"><h2>Field Mappings</h2>
      {editingProfile && session?.source ? <>
        <label>Profile name<input value={profileName} onChange={(event) => setProfileName(event.target.value)} placeholder="Commerce account transfer" /></label>
        <p>For each target field, choose the source field by its business label. Source values are not displayed or stored in the Profile.</p>
        {session.targets.map((target) => <article key={target.id} className="profile-target"><h3>{target.title}</h3>
          {!session.mappingProfileId && !session.frozen && (target.observation?.groups?.length ?? 0) > 1 && <label>Target section<select aria-label={`Target section ${target.title}`} disabled={disabled} value={target.observation?.selectedGroups?.[0] ?? ""} onChange={(event) => void run({ type: "SET_TARGET_GROUPS", targetId: target.id, groups: event.target.value ? [event.target.value] : [] })}><option value="">All sections (up to 120 controls)</option>{target.observation?.groups?.map((group) => <option key={group.name} value={group.name}>{group.name || "Ungrouped"} ({group.count})</option>)}</select></label>}
        {target.plan?.actions.map((action) => {
          const configured = profileDraft[target.id]?.[action.field.instanceKey] ?? { existingValuePolicy: "blank_only" as const }
          const invalid = profileValidationAttempted && configured.existingValuePolicy !== "skip" && !session.source!.fields.some((field) => field.instanceKey === configured.sourceInstanceKey)
          return <div key={action.field.instanceKey} className={`profile-field${invalid ? " profile-field--invalid" : ""}`}><strong>{action.field.label}</strong><small>Target current value: {String(action.field.display || "Blank")}</small>
            <label>Use source field<select aria-invalid={invalid} value={configured.existingValuePolicy === "skip" ? PROFILE_FIELD_NOT_APPLICABLE : configured.sourceInstanceKey ?? ""} onChange={(event) => updateProfileField(target.id, action.field.instanceKey, event.target.value === PROFILE_FIELD_NOT_APPLICABLE
              ? { sourceInstanceKey: undefined, existingValuePolicy: "skip" }
              : { sourceInstanceKey: event.target.value || undefined, existingValuePolicy: configured.existingValuePolicy === "skip" ? "blank_only" : configured.existingValuePolicy })}>
              <option value="">Choose a source field</option>
              {session.source!.fields.map((field) => <option key={field.instanceKey} value={field.instanceKey}>{field.label}</option>)}
              <option value={PROFILE_FIELD_NOT_APPLICABLE}>N/A (no matching source field)</option>
            </select></label>
            <label>Existing value policy<select value={configured.existingValuePolicy} onChange={(event) => {
              const existingValuePolicy = event.target.value as typeof configured.existingValuePolicy
              updateProfileField(target.id, action.field.instanceKey, { existingValuePolicy, ...(existingValuePolicy === "skip" ? { sourceInstanceKey: undefined } : {}) })
            }}>
              <option value="blank_only">Fill blank fields only</option><option value="overwrite">Always overwrite this field</option><option value="skip">Never fill this field</option>
            </select></label>
            {invalid && <small className="profile-field-error">Choose a source field or set this field to Never fill.</small>}
          </div>
        })}
        </article>)}
        <button disabled={disabled || !profileName.trim()} onClick={() => void saveProfile()}>Save Profile</button>
        {selectedProfileId && <button disabled={disabled} onClick={() => void removeProfile()}>Delete Profile</button>}
      </> : <>
        <p>Select the source and target tabs, then continue to load their field mappings.</p>
        <button disabled>Save Profile</button>
      </>}
      <button disabled={disabled} onClick={cancelCreateProfile}>{selectedProfileId ? "Close" : "Cancel"}</button>
    </section>}
    </details>
    {session?.profileDrift && <section className="card profile-drift" aria-label="Profile Drift Report">
      <h2>Profile changed</h2>
      <p>Review the detected changes. Only compatible saved mappings can be filled; new and changed fields stay blocked.</p>
      {session.profileDrift.reports.map((report, index) => <article key={index}>
        <h3>{report.page === "source" ? "Source" : "Target"}: {report.title}</h3>
        <p>{report.unchangedMappedFields.length}/{report.unchangedMappedFields.length + report.blockedKeys.length} mapped fields remain compatible · {report.newFields.length} new unmapped fields detected</p>
        {([
          ["Unchanged mapped fields", report.unchangedMappedFields],
          ["Missing mapped fields", report.missingMappedFields],
          ["New fields", report.newFields],
          ["Changed control types", report.changedControlTypes],
          ["Ambiguous fields", report.ambiguousFields],
        ] as const).map(([label, fields]) => <details key={label} open={fields.length > 0 && label !== "Unchanged mapped fields"}>
          <summary>{label}: {fields.length}</summary><ul>{fields.map((field, fieldIndex) => <li key={fieldIndex}>{field}</li>)}</ul>
        </details>)}
      </article>)}
      {!session.profileDrift.reviewed ? <button disabled={disabled || !readyCount} onClick={() => void run({ type: "APPROVE_PROFILE_DRIFT" })}>Approve compatible fields</button>
        : <p role="status">Drift reviewed for this batch. Use Fill below, or Open Profile and Save Profile to retain the reviewed page structure as a new revision.</p>}
    </section>}
    {profilePrepared && <>
    <section className="card"><h2>This batch · {session?.status.replaceAll("_", " ") ?? "draft"}</h2>
      <p>{preparedTargets.length} of {session?.targets.length ?? 0} target pages prepared · {readyCount} fields ready · {pending} issues</p>
      <button disabled={disabled || !runnableTargets.length || Boolean(session?.profileDrift && !session.profileDrift.reviewed)} onClick={() => void run({ type: "RUN_TRANSFER" })}>Fill {session?.targets.length ?? 0} target {(session?.targets.length ?? 0) === 1 ? "page" : "pages"}</button>
      {running && <button onClick={() => void run({ type: "CANCEL_TRANSFER" })}>Cancel remaining work</button>}
      <p>Filled and checked means the page accepted the value. Review and submit on each website.</p>
    </section>
    <section className="card"><h2>Target results</h2>
      {session?.targets.map((target) => {
        const issues = target.plan?.actions.filter((action) => !successful(action.status) && !["ready", "skipped"].includes(action.status)) ?? []
        return <article key={target.id} className="transfer-target"><h3>{target.title}</h3><p>{target.origin} · {target.status.replaceAll("_", " ")}</p>
        {target.observation && <p>Record: {target.observation.identityEvidence.map((item) => `${item.label}: ${item.value}`).join(" · ") || (target.observation.identityConfidence === "new_form" ? "New blank form" : "Identity not detected")}</p>}
        {target.error && <p role="alert">{target.error}</p>}
        {target.observation?.truncated && <p role="alert">Target scan truncated: only the first 120 eligible controls are covered.</p>}
        <p>{target.plan?.actions.filter((a) => successful(a.status)).length ?? 0} fields checked / {target.plan?.actions.length ?? 0} candidates</p>
        {issues.length > 0 && <div className="transfer-issues" role="status"><strong>Resolve on this target page:</strong><ul>{issues.map((action) => <li key={action.field.instanceKey}><span>{action.field.label}</span>: {action.reason}</li>)}</ul></div>}
        <button onClick={() => void chrome.tabs.update(target.tabId, { active: true }).catch((caught) => {
          const message = caught instanceof Error ? caught.message : String(caught)
          if (activeSessionIsAiFill) setAiFillError(message)
          else setProfileError(message)
        })}>Open target</button>
        <button disabled={disabled} onClick={() => void run({ type: "RESUME_TARGET", targetId: target.id })}>Recheck after fixing page</button>
        <p className="help">Problems are shown for review. Fix them directly on the target website. Recheck is optional and only needed to retry remaining fields.</p>
        <button disabled={disabled} onClick={() => void run({ type: "REMOVE_TARGET", targetId: target.id })}>Remove target</button>
      </article>})}
    </section>
    </>}
  </main>
}
