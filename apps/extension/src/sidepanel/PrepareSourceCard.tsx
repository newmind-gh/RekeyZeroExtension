import { useEffect, useRef, useState } from "react"
import { prepareSourceDocument, validatePreparedDocuments, SOURCE_DOCUMENT_ACCEPT } from "../personal/source-prepare/document-converter"
import type { PreparedDocument, SourcePrepareView } from "../personal/source-prepare/source-prepare-session"
import type { Snapshot } from "../transfer/types"
import { isBlankSourceValue } from "../personal/source-prepare/source-value-normalizer"
import { worker } from "./client"
import { PREPARE_DRAFT_PREFIX } from "../personal/source-prepare/source-prepare-store"

type Props = { source?: Snapshot; tabId?: number; aiReady: boolean; supportsExtraction: boolean; busy: boolean;
  onBusy: (busy: boolean) => void; onComplete: () => Promise<void> }
export function PrepareSourceCard({ source, tabId, aiReady, supportsExtraction, busy, onBusy, onComplete }: Props) {
  const [documents, setDocuments] = useState<PreparedDocument[]>([])
  const [view, setView] = useState<SourcePrepareView | null>(null)
  const [error, setError] = useState("")
  const [working, setWorking] = useState(false)
  const [evidenceVisible, setEvidenceVisible] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const documentGeneration = useRef(0)
  useEffect(() => {
    let cancelled = false
    documentGeneration.current++
    setDocuments([]); setView(null); setError("")
    if (tabId === undefined) return
    const load = async () => {
      const key = `${PREPARE_DRAFT_PREFIX}${tabId}`
      const saved = (await chrome.storage.session.get(key))[key]
      if (cancelled) return
      if (Array.isArray(saved) && saved.length) { validatePreparedDocuments(saved); setDocuments(saved) }
      else setDocuments([])
      const latest = await worker<SourcePrepareView | null>({ type: "PERSONAL_GET_PREPARE_SOURCE" })
      if (!cancelled) setView(latest?.tabId === tabId ? latest : null)
    }
    void load().catch(() => undefined)
    const changed = (_changes: Record<string, chrome.storage.StorageChange>, area: string) => { if (area === "session") void load().catch(() => undefined) }
    chrome.storage.onChanged.addListener(changed)
    const navigated = (id: number, changes: chrome.tabs.OnUpdatedInfo) => {
      if (id === tabId && (changes.url || changes.status === "loading")) { documentGeneration.current++; setDocuments([]); setView(null) }
    }
    chrome.tabs.onUpdated.addListener(navigated)
    return () => { cancelled = true; chrome.storage.onChanged.removeListener(changed); chrome.tabs.onUpdated.removeListener(navigated) }
  }, [tabId])
  const saveDocuments = async (next: PreparedDocument[]) => {
    if (tabId === undefined) return
    if (next.length) validatePreparedDocuments(next)
    await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
    const key = `${PREPARE_DRAFT_PREFIX}${tabId}`
    if (next.length) await chrome.storage.session.set({ [key]: next })
    else await chrome.storage.session.remove(key)
    setDocuments(next)
  }
  const addFiles = async (files: File[]) => {
    if (busy || tabId === undefined || !files.length) return
    setError(""); onBusy(true)
    const generation = documentGeneration.current
    try {
      if (documents.length + files.length > 6) throw new Error("Add between 1 and 6 source documents")
      const processed = await Promise.allSettled(files.map(prepareSourceDocument))
      if (generation !== documentGeneration.current) return
      const next = [...documents], errors: string[] = []
      processed.forEach((result, index) => {
        if (result.status === "rejected") {
          errors.push(`${files[index].name}: ${result.reason instanceof Error ? result.reason.message : "This document could not be converted to text."}`)
        } else {
          try { validatePreparedDocuments([...next, result.value]); next.push(result.value) }
          catch (caught) { errors.push(caught instanceof Error ? caught.message : "This document could not be converted to text.") }
        }
      })
      await saveDocuments(next)
      setError(errors.join(" "))
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not read this document") }
    finally { onBusy(false); if (fileInput.current) fileInput.current.value = "" }
  }
  const prepare = async () => {
    setError(""); setWorking(true); onBusy(true)
    try {
      const prepared = await worker<SourcePrepareView>({ type: "PERSONAL_PREPARE_SOURCE", documentIds: documents.map((document) => document.id) })
      setView(prepared)
      if (!prepared.summary.filled && !prepared.summary.conflicts) setError(prepared.summary.stale
        ? "The source page changed while extraction was running. Run Prepare Source again."
        : "No supported values were found for blank fields on this page.")
      await onComplete()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Source preparation failed")
      setView(await worker<SourcePrepareView | null>({ type: "PERSONAL_GET_PREPARE_SOURCE" }).catch(() => null))
    } finally { setWorking(false); onBusy(false) }
  }
  const undo = async () => {
    if (!view) return
    setError(""); onBusy(true)
    try { setView(await worker<SourcePrepareView>({ type: "PERSONAL_UNDO_PREPARE_SOURCE", sessionId: view.sessionId })); await onComplete() }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Undo could not complete") }
    finally { onBusy(false) }
  }
  const clear = async () => {
    onBusy(true); setError("")
    try {
      if (view) await worker({ type: "PERSONAL_CLEAR_PREPARE_SOURCE", sessionId: view.sessionId })
      await saveDocuments([]); setView(null); setEvidenceVisible(false)
    } catch { setError("Could not clear source preparation") }
    finally { onBusy(false) }
  }
  const blanks = source?.fields.filter((field) => field.writable && field.instanceStable && !field.ambiguousInObservation && isBlankSourceValue(field.value)).length ?? 0
  return <section className="source-prepare" aria-label="Prepare Source with AI">
    <h3>Prepare Source with AI</h3>
    {error && <p role="alert" className="error">{error}</p>}
    <div className="source-document-drop" onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
      event.preventDefault(); void addFiles(Array.from(event.dataTransfer.files))
    }}>
      <p>Drop or upload digital PDF, DOCX, XLSX, PPTX, TXT, Markdown, HTML, CSV, or EML documents.</p>
      <input ref={fileInput} aria-label="Source documents" type="file" multiple accept={SOURCE_DOCUMENT_ACCEPT} hidden
        disabled={busy || tabId === undefined} onChange={(event) => void addFiles(Array.from(event.target.files ?? []))} />
      <button type="button" disabled={busy || tabId === undefined} onClick={() => fileInput.current?.click()}>Upload documents</button>
    </div>
    {documents.length > 0 && <ul>{documents.map((document) => <li key={document.id}>{document.name} · Ready
      <button type="button" disabled={busy} aria-label={`Remove document ${document.name}`} onClick={() => void saveDocuments(documents.filter((item) => item.id !== document.id)).catch(() => setError("Could not remove this document"))}>Remove</button>
      <DocumentPrivacySummary document={document} />
    </li>)}</ul>}
    <p className="help">Documents are converted to Markdown and privacy-processed locally. Only redacted Markdown is sent directly from this browser to the selected AI provider. RekeyZero does not operate a proxy.</p>
    <p className="help">Privacy detection is best-effort and may not identify every sensitive item. Masked values are unavailable for extraction and are never restored.</p>
    <p className="help">Document content, privacy findings, evidence, and extracted values stay only in this browser session. Existing source values are never overwritten. Up to 6 documents, 10 MB each, 80,000 Markdown characters total. Scanned PDFs, OCR, and MSG are not supported by the current converter.</p>
    {!supportsExtraction && <p className="help">This model does not support document extraction. Choose another AI model.</p>}
    <button type="button" disabled={busy || !aiReady || !supportsExtraction || !source || !documents.length || !blanks}
      onClick={() => void prepare()}>{working ? "Extracting & filling…" : "Extract & fill source"}</button>
    {view && !["extracting", "filling"].includes(view.status) && <div className="source-prepare-summary">
      <strong>{view.status === "undone" ? `Undo finished: ${view.undoSummary?.restored ?? 0} restored · ${view.undoSummary?.preserved ?? 0} user values preserved · ${view.undoSummary?.stale ?? 0} stale` : "Review on the source page"}</strong>
      <p>{view.summary.filled} AI-filled · {view.summary.preserved} preserved during extraction · {view.summary.conflicts} conflicts to review · {view.summary.ambiguous} ambiguous · {view.summary.notFound} not found · {view.summary.invalid} invalid · {view.summary.stale} stale</p>
      <button type="button" disabled={busy || !view.canUndo || view.status === "undone"} onClick={() => void undo()}>Undo AI fill</button>
      <button type="button" disabled={busy} onClick={() => {
        void worker({ type: "PERSONAL_SHOW_PREPARE_EVIDENCE", sessionId: view.sessionId, visible: !evidenceVisible })
          .then(() => setEvidenceVisible(!evidenceVisible)).catch(() => setError("Could not show evidence on the source page"))
      }}>{evidenceVisible ? "Hide evidence" : "Show evidence"}</button>
    </div>}
    {(documents.length > 0 || view) && <>
      <button type="button" disabled={busy} onClick={() => void clear()}>Clear documents &amp; evidence</button>
      <p className="help">Documents, evidence and Undo history will be cleared. Filled source values will remain.</p>
    </>}
  </section>
}

function DocumentPrivacySummary({ document }: { document: PreparedDocument }) {
  const categories = new Map<string, { name: string; count: number }>()
  for (const finding of document.privacy.findings) {
    const category = categories.get(finding.type) ?? { name: finding.displayName, count: 0 }
    category.count++; categories.set(finding.type, category)
  }
  return <div className="source-privacy-summary">
    <strong>Privacy check</strong>
    <p>{document.privacy.findings.length ? `${document.privacy.findings.length} items detected and redacted` : "No common privacy-sensitive patterns detected."}</p>
    {document.privacy.findings.length > 0 && <details aria-label={`Privacy details for ${document.name}`}>
      <summary>View details</summary>
      <ul>{[...categories].map(([type, category]) => <li key={type}>{category.name}: {category.count}</li>)}</ul>
      <p>{document.privacy.findings.map((finding) => finding.placeholder).join(" · ")}</p>
    </details>}
  </div>
}
