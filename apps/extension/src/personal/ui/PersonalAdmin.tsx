import { Copy, Download, Pencil, RefreshCw, Shield, Trash2 } from "lucide-react"
import { useEffect, useState } from "react"

import type { PersonalAiSettingsView, PersonalHomeData } from "../../shared/types"
import { worker } from "../../sidepanel/client"
import type { MappingProfile, ProfileFieldMapping } from "../../transfer/types"
import type { PersonalLlmLog } from "../storage/schema"

import { importMappingProfile, PROFILE_FILE_LIMIT_BYTES } from "../../transfer/profile-portability"

type Tab = "profiles" | "ai" | "log" | "privacy"

function downloadExport(value: string, kind = "data") {
  const url = URL.createObjectURL(new Blob([value], { type: "application/json" }))
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = `rekeyzero-${kind}-${new Date().toISOString().slice(0, 10)}.json`
  anchor.click()
  URL.revokeObjectURL(url)
}

export function PersonalAdmin() {
  const [tab, setTab] = useState<Tab>("profiles")
  const [home, setHome] = useState<PersonalHomeData | null>(null)
  const [ai, setAi] = useState<PersonalAiSettingsView | null>(null)
  const [profileDraft, setProfileDraft] = useState<MappingProfile | null>(null)
  const [importPreview, setImportPreview] = useState<{ content: string; profile: MappingProfile } | null>(null)
  const [logs, setLogs] = useState<PersonalLlmLog[]>([])
  const [editingProfile, setEditingProfile] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")

  const load = async () => {
    const [nextHome, nextAi, nextLogs] = await Promise.all([
      worker<PersonalHomeData>({ type: "PERSONAL_GET_HOME" }),
      worker<PersonalAiSettingsView>({ type: "PERSONAL_GET_AI_SETTINGS" }),
      worker<PersonalLlmLog[]>({ type: "PERSONAL_GET_LLM_LOGS" }),
    ])
    setHome(nextHome)
    setAi(nextAi)
    setLogs(nextLogs)
  }
  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setError(""); setNotice("")
    try { await operation() }
    catch (caught) { setError(caught instanceof Error ? caught.message : "The action failed") }
    finally { setBusy(false) }
  }
  useEffect(() => { void run(load) }, [])

  const previewProfile = (file: File) => run(async () => {
    setImportPreview(null)
    if (file.size > PROFILE_FILE_LIMIT_BYTES) throw new Error("Profile file exceeds 1 MB")
    const content = await file.text()
    const profile = importMappingProfile(content, chrome.runtime.getManifest().version)
    setImportPreview({ content, profile })
  })
  const confirmImport = () => run(async () => {
    if (!importPreview) return
    const updated = await worker<PersonalHomeData>({ type: "PERSONAL_IMPORT_PROFILE", content: importPreview.content })
    setHome(updated); setTab(importPreview.profile.kind === "ai_fill_setup" ? "ai" : "profiles")
    setImportPreview(null); setNotice("Profile imported as a new copy. Website permissions are requested only when you use it.")
  })
  const exportProfile = (profileId: string) => run(async () => {
    downloadExport(await worker<string>({ type: "PERSONAL_EXPORT_PROFILE", profileId }), "profile")
  })
  const openProfile = (profile: MappingProfile) => {
    setProfileDraft(structuredClone(profile)); setEditingProfile(false); setError(""); setNotice("")
  }
  const updateMapping = (targetId: string, index: number, patch: Partial<ProfileFieldMapping>) => {
    setProfileDraft((current) => current ? { ...current, targets: current.targets.map((target) => target.id === targetId
      ? { ...target, mappings: target.mappings.map((mapping, mappingIndex) => mappingIndex === index ? { ...mapping, ...patch } : mapping) }
      : target) } : null)
  }
  const saveProfile = () => run(async () => {
    if (!profileDraft) return
    const updated = await worker<PersonalHomeData>({ type: "PERSONAL_SAVE_PROFILE", profile: profileDraft })
    const saved = updated.profiles.find((profile) => profile.id === profileDraft.id) ?? null
    setHome(updated); setProfileDraft(saved ? structuredClone(saved) : null); setEditingProfile(false)
    setNotice("Profile saved. The Side Panel profile list has been refreshed.")
  })
  const deleteProfile = () => {
    if (!profileDraft || !confirm(`Delete “${profileDraft.name}”?`)) return
    void run(async () => {
      const updated = await worker<PersonalHomeData>({ type: "PERSONAL_DELETE_PROFILE", profileId: profileDraft.id })
      setHome(updated); setProfileDraft(null); setEditingProfile(false)
      setNotice("Profile deleted from RekeyZero Personal.")
    })
  }

  return <div className="personal-shell"><aside>
    <div className="personal-brand">RekeyZero <span>Admin</span></div>
    {(["profiles", "ai", "log", "privacy"] as Tab[]).map((item) => <button key={item} className={tab === item ? "active" : ""} onClick={() => { setTab(item); if (item === "log") void worker<PersonalLlmLog[]>({ type: "PERSONAL_GET_LLM_LOGS" }).then(setLogs) }}>{item === "ai" ? "AI Setups" : item[0].toUpperCase() + item.slice(1)}</button>)}
  </aside><main className="personal-main">
    {error && <div className="error" role="alert">{error}</div>}{notice && <div className="notice" role="status">{notice}</div>}
    {(tab === "profiles" || tab === "ai") && <section className="personal-card">
      <label>Import Profile<input aria-label="Import Profile" type="file" accept=".json,application/json" disabled={busy} onChange={(event) => {
        const file = event.target.files?.[0]; event.target.value = ""; if (file) void previewProfile(file)
      }} /></label>
      <p>Profile files contain page and field identities and mapping policies. They contain no runtime field values or API keys.</p>
      {importPreview && <div aria-label="Profile import preview"><h2>Review Profile import</h2>
        <p>{importPreview.profile.name} · {importPreview.profile.targets.length} target pages</p>
        <p>Source: {importPreview.profile.source.origin}{importPreview.profile.source.pathPattern}</p>
        <ul>{importPreview.profile.targets.map((target) => <li key={target.id}>{target.origin}{target.pathPattern} · {target.mappings.filter((mapping) => mapping.existingValuePolicy !== "skip").length} active mappings · {target.mappings.filter((mapping) => mapping.existingValuePolicy === "overwrite").length} allow overwrite</li>)}</ul>
        <button disabled={busy} onClick={() => void confirmImport()}>Import as new Profile</button>
        <button disabled={busy} onClick={() => setImportPreview(null)}>Cancel import</button>
      </div>}
    </section>}
    {!home || !ai ? <section className="personal-card loading"><RefreshCw className={busy ? "spin" : ""} />{error ? "Admin storage could not be opened." : "Loading admin data…"}</section> : <>
      {tab === "profiles" && <section><div className="personal-heading"><div><h1>Profiles</h1><p>Manage the Mapping Profiles used by the Personal Side Panel.</p></div></div><div className="profile-layout">
        <div className="personal-card profile-list">{home.profiles.filter((profile) => profile.kind !== "ai_fill_setup").map((profile) => <div className={profileDraft?.id === profile.id ? "selected" : ""} key={profile.id}><div><strong>{profile.name}</strong><span>{profile.source.title} → {profile.targets.length} target {profile.targets.length === 1 ? "page" : "pages"} · revision {profile.revision ?? 1}</span><small>Updated {new Date(profile.updatedAt).toLocaleString()}</small></div><button className="secondary" disabled={busy} onClick={() => openProfile(profile)}>Open</button></div>)}{!home.profiles.some((profile) => profile.kind !== "ai_fill_setup") && <p className="empty-copy">No profiles yet. Create one from the Side Panel.</p>}</div>
        {profileDraft && <div className="personal-card profile-detail"><div className="profile-detail-heading"><div><h2>{editingProfile ? "Edit Profile" : profileDraft.name}</h2><p>Source: {profileDraft.source.title}</p></div><div className="button-row">{!editingProfile ? <button onClick={() => setEditingProfile(true)}><Pencil size={16} />Edit</button> : <><button onClick={() => void saveProfile()} disabled={busy}>Save</button><button className="secondary" onClick={() => openProfile(home.profiles.find((profile) => profile.id === profileDraft.id)!)}>Cancel</button></>}<button disabled={busy || editingProfile} onClick={() => void exportProfile(profileDraft.id)}><Download size={16} />Export Profile</button><button className="danger" onClick={deleteProfile} disabled={busy}><Trash2 size={16} />Delete</button></div></div>
          <label>Profile name<input aria-label="Profile name" disabled={!editingProfile} value={profileDraft.name} onChange={(event) => setProfileDraft({ ...profileDraft, name: event.target.value })} /></label>
          <dl className="profile-page-identity"><div><dt>Source site</dt><dd>{profileDraft.source.origin}</dd></div><div><dt>Page pattern</dt><dd>{profileDraft.source.pathPattern}</dd></div></dl>
          {profileDraft.targets.map((target) => <section className="profile-target" key={target.id}><h3>{target.title}</h3><p>{target.origin}{target.pathPattern}</p><div className="profile-mappings">{target.mappings.map((mapping, index) => <div className="profile-mapping" key={`${target.id}-${index}`}><label>Source field key<input disabled={!editingProfile || mapping.existingValuePolicy === "skip"} value={mapping.sourceTemplateKey} onChange={(event) => updateMapping(target.id, index, { sourceTemplateKey: event.target.value })} /></label><label>Target field key<input disabled={!editingProfile} value={mapping.targetTemplateKey} onChange={(event) => updateMapping(target.id, index, { targetTemplateKey: event.target.value })} /></label><label>Existing value<select disabled={!editingProfile} value={mapping.existingValuePolicy} onChange={(event) => updateMapping(target.id, index, { existingValuePolicy: event.target.value as ProfileFieldMapping["existingValuePolicy"] })}><option value="blank_only">Fill only when blank</option><option value="overwrite">Allow overwrite</option><option value="skip">Skip field</option></select></label></div>)}</div></section>)}
          <p className="profile-help">Page identities are protected here. Use <strong>Open Profile</strong> in the Side Panel to rebuild a profile against open pages.</p>
        </div>}
      </div></section>}
      {tab === "ai" && <section><div className="personal-heading"><div><h1>AI Setups</h1><p>Saved AI Fill Setups from the Personal Side Panel.</p></div></div><div className="personal-card setup-list">{home.profiles.filter((profile) => profile.kind === "ai_fill_setup").map((setup) => <div key={setup.id}><div><strong>{setup.name}</strong><span>{setup.source.title} → {setup.targets.map((target) => target.title).join(", ")}</span><small>{setup.targets.reduce((count, target) => count + target.mappings.filter((mapping) => mapping.existingValuePolicy !== "skip").length, 0)} mapped fields · Updated {new Date(setup.updatedAt).toLocaleString()}</small></div><button disabled={busy} onClick={() => void exportProfile(setup.id)}>Export Profile</button></div>)}{!home.profiles.some((profile) => profile.kind === "ai_fill_setup") && <p className="empty-copy">No AI Fill Setups yet. Create one from the Side Panel.</p>}</div></section>}
      {tab === "log" && <section><div className="personal-heading"><div><h1>Log</h1><p>Browser-local AI requests, responses, matching results, and extension runtime errors.</p></div><div className="button-row"><button className="secondary" disabled={busy || !logs.length} onClick={() => void run(async () => { await navigator.clipboard.writeText(JSON.stringify(logs, null, 2)); setNotice("Log copied to clipboard.") })}><Copy size={16} />Copy</button><button className="secondary" disabled={busy} onClick={() => void run(async () => setLogs(await worker<PersonalLlmLog[]>({ type: "PERSONAL_GET_LLM_LOGS" })))}><RefreshCw size={16} />Refresh log</button></div></div><p className="log-warning">These logs stay in this browser. Field matching sends labels and control metadata to the selected AI model, not source field values. Runtime errors include their original message and stack.</p>{logs.length ? <pre className="personal-card llm-log-raw">{JSON.stringify(logs, null, 2)}</pre> : <div className="personal-card"><p className="empty-copy">No AI requests or runtime errors have been logged yet.</p></div>}</section>}
      {tab === "privacy" && <section><div className="personal-heading"><div><h1>Privacy</h1><p>Admin data stays in this browser.</p></div></div><div className="personal-card privacy-card"><Shield size={28} /><h2>No RekeyZero Cloud telemetry</h2><p>Gemini, OpenAI, Claude, and DeepSeek credentials are entered in the Side Panel and stored only for the current browser session. API requests go directly to the selected provider. Prepare Source sends uploaded document content for extraction; matching sends field metadata. Preparation documents, evidence, and extracted values remain session-only and are excluded from Profiles, durable logs, and exports. Keys must be entered again after the browser restarts.</p><div className="button-row"><button onClick={() => void run(async () => downloadExport(await worker<string>({ type: "PERSONAL_EXPORT" })))}><Download size={16} />Export admin data</button><button onClick={() => void run(async () => downloadExport(await worker<string>({ type: "PERSONAL_EXPORT_DIAGNOSTICS" }), "diagnostics"))}><Download size={16} />Export diagnostics</button><button className="danger" onClick={() => { if (confirm("Delete all RekeyZero data from this browser?")) void run(async () => { await worker({ type: "PERSONAL_CLEAR_ALL" }); await load() }) }}><Trash2 size={16} />Clear all data</button></div></div></section>}
    </>}
  </main></div>
}
