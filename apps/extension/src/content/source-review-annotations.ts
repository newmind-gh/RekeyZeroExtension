import type { Control, ControlAdapter } from "../transfer/control-adapters"
import type { SourceReviewMark } from "../personal/source-prepare/source-prepare-session"

type Annotation = { mark: SourceReviewMark; host: HTMLElement; control: Control; adapter: ControlAdapter;
  evidence: HTMLElement; badge: HTMLButtonElement; restore: () => void; edited: boolean; url: string }
const annotations = new Map<string, Annotation>()
let timer: ReturnType<typeof setInterval> | undefined
const key = (mark: SourceReviewMark) => `${mark.sessionId}:${mark.fieldKey}`
function remove(annotation: Annotation) { annotation.restore(); annotation.host.remove(); annotations.delete(key(annotation.mark)) }
export function clearSourceAnnotations(sessionId?: string): void {
  for (const annotation of annotations.values()) if (!sessionId || annotation.mark.sessionId === sessionId) remove(annotation)
  if (!annotations.size) { clearInterval(timer); timer = undefined }
}
export function toggleSourceEvidence(sessionId: string, visible: boolean): void {
  for (const annotation of annotations.values()) if (annotation.mark.sessionId === sessionId) {
    annotation.evidence.hidden = !visible; annotation.badge.setAttribute("aria-expanded", String(visible))
  }
}
export function pruneSourceAnnotations(pageIdentity: string): void {
  for (const annotation of annotations.values()) if (annotation.mark.pageIdentity !== pageIdentity) remove(annotation)
}
export function markSourceReview(mark: SourceReviewMark, control: Control, adapter: ControlAdapter): void {
  const previous = annotations.get(key(mark))
  if (previous) remove(previous)
  const element = control.elements[0] as HTMLElement
  const document = element.ownerDocument
  const host = document.createElement("span")
  host.dataset.rekeyzeroUi = "source-evidence"
  const shadow = host.attachShadow({ mode: "open" })
  const style = document.createElement("style")
  style.textContent = `:host{display:block;font:12px/1.5 system-ui;margin:3px 0;color:#14532d}
    button{font:inherit;cursor:pointer;background:#f0fdf4;border:1px solid #86efac;border-radius:4px;padding:2px 6px;color:#14532d}
    :host([data-conflict]) button{background:#fffbeb;border-color:#fcd34d;color:#92400e}
    aside{max-width:450px;padding:6px;background:#fff;border:1px solid #cbd5e1;white-space:pre-wrap;overflow-wrap:anywhere;color:#17201d}
    aside[hidden]{display:none}`
  const badge = document.createElement("button")
  badge.type = "button"
  badge.textContent = mark.status === "conflict" ? "Existing value preserved" : "AI filled"
  badge.setAttribute("aria-expanded", "false")
  const evidence = document.createElement("aside")
  evidence.hidden = true
  for (const reference of mark.evidence) {
    const excerpt = document.createElement("p")
    excerpt.textContent = `${reference.documentName}${reference.page ? ` · Page ${reference.page}` : ""}\n“${reference.quote}”`
    evidence.append(excerpt)
  }
  if (mark.status === "conflict") {
    const note = document.createElement("p")
    note.textContent = "RekeyZero preserved the existing value. Review and edit it directly on this page."
    evidence.append(note)
    host.dataset.conflict = "true"
  }
  shadow.append(style, badge, evidence)
  // Evidence is outside the associated label, so accessible names stay unchanged.
  ;(element.closest("label") ?? element).after(host)
  const oldStyles = control.elements.map((node) => {
    const item = node as HTMLElement
    const original = { outline: item.style.outline, background: item.style.backgroundColor }
    item.style.outline = mark.status === "conflict" ? "2px solid #f59e0b" : "2px solid #86efac"
    item.style.backgroundColor = mark.status === "conflict" ? "#fffbeb" : "#f0fdf4"
    item.dataset.rekeyzeroReviewId = mark.fieldKey
    return { item, original }
  })
  const toggle = () => { evidence.hidden = !evidence.hidden; badge.setAttribute("aria-expanded", String(!evidence.hidden)) }
  const annotation: Annotation = { mark, host, control, adapter, evidence, badge, edited: false, url: document.URL,
    restore: () => {
      for (const { item, original } of oldStyles) {
        item.style.outline = original.outline; item.style.backgroundColor = original.background
        delete item.dataset.rekeyzeroReviewId
        item.removeEventListener("click", toggle); item.removeEventListener("input", edited); item.removeEventListener("change", edited)
      }
    },
  }
  const edited = () => {
    if (mark.status !== "filled" || annotation.edited || Object.is(adapter.read(control), mark.appliedValue)) return
    annotation.edited = true
    badge.textContent = "Reviewed / edited"
    void chrome.runtime.sendMessage({ type: "PERSONAL_PREPARE_SOURCE_EDITED", sessionId: mark.sessionId, fieldKey: mark.fieldKey }).catch(() => undefined)
  }
  badge.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); toggle() })
  for (const node of control.elements) { node.addEventListener("click", toggle); node.addEventListener("input", edited); node.addEventListener("change", edited) }
  annotations.set(key(mark), annotation)
  timer ??= setInterval(() => {
    for (const item of annotations.values()) if (!item.control.elements.every((node) => node.isConnected) || item.control.elements[0].ownerDocument.URL !== item.url) remove(item)
    if (!annotations.size) { clearInterval(timer); timer = undefined }
  }, 1000)
}
globalThis.addEventListener("pagehide", () => clearSourceAnnotations())
globalThis.addEventListener("popstate", () => clearSourceAnnotations())
