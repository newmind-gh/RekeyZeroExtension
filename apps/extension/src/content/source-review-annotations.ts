import type { Control } from "../transfer/control-adapters"
import type { SourceReviewMark } from "../personal/source-prepare/source-prepare-session"

type Overlay = { host: HTMLElement; shadow: ShadowRoot; dispose: () => void }
type Annotation = { mark: SourceReviewMark; host: HTMLElement; control: Control; evidence: HTMLElement;
  badge: HTMLButtonElement; outlines: HTMLElement[]; url: string }
const overlays = new Map<Document, Overlay>()
const annotations = new Map<string, Annotation>()
let timer: ReturnType<typeof setInterval> | undefined
let frame: number | undefined
const key = (mark: SourceReviewMark) => `${mark.sessionId}:${mark.fieldKey}`
function remove(annotation: Annotation): void {
  annotation.host.remove()
  for (const outline of annotation.outlines) outline.remove()
  annotations.delete(key(annotation.mark))
}
function cleanup(): void {
  for (const [document, overlay] of overlays) {
    if (![...annotations.values()].some((annotation) => annotation.control.elements[0].ownerDocument === document)) {
      overlay.dispose(); overlay.host.remove(); overlays.delete(document)
    }
  }
  if (!annotations.size) {
    clearInterval(timer); timer = undefined
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
  }
}
function position(annotation: Annotation): void {
  const element = annotation.control.elements[0] as HTMLElement
  const document = element.ownerDocument
  const view = document.defaultView
  if (!view || !annotation.host.isConnected || !annotation.control.elements.every((node) => node.isConnected)
    || document.URL !== annotation.url || !overlays.get(document)?.host.isConnected) {
    remove(annotation); return
  }
  const rectangles = annotation.control.elements.map((node) => node.getBoundingClientRect())
  const bounds = rectangles[0]
  const visible = element.getClientRects().length > 0 && view.getComputedStyle(element).visibility !== "hidden"
    && bounds.bottom > 0 && bounds.right > 0 && bounds.top < view.innerHeight && bounds.left < view.innerWidth
  annotation.host.hidden = !visible
  rectangles.forEach((rectangle, index) => {
    const outline = annotation.outlines[index]
    outline.hidden = !visible
    Object.assign(outline.style, { left: `${rectangle.left}px`, top: `${rectangle.top}px`, width: `${rectangle.width}px`, height: `${rectangle.height}px` })
  })
  if (!visible) return
  const badgeWidth = annotation.badge.offsetWidth
  const left = bounds.right + badgeWidth + 8 <= view.innerWidth ? bounds.right + 4 : Math.max(4, bounds.left)
  const top = bounds.right + badgeWidth + 8 <= view.innerWidth ? Math.max(4, bounds.top) : Math.max(4, bounds.bottom + 4)
  Object.assign(annotation.host.style, { left: `${left}px`, top: `${top}px`, maxWidth: `${Math.max(1, view.innerWidth - left - 4)}px` })
  annotation.evidence.style.maxHeight = `${Math.max(40, view.innerHeight - top - annotation.badge.offsetHeight - 8)}px`
}
function reposition(): void {
  for (const annotation of annotations.values()) position(annotation)
  cleanup()
}
function schedule(): void {
  if (frame === undefined) frame = requestAnimationFrame(() => { frame = undefined; reposition() })
}
function overlayFor(document: Document): Overlay {
  const existing = overlays.get(document)
  if (existing?.host.isConnected) return existing
  existing?.dispose()
  const view = document.defaultView
  if (!view || !document.body) throw new Error("Source annotation overlay is unavailable")
  const host = document.createElement("div")
  host.dataset.rekeyzeroUi = "source-overlay"
  // All visual nodes live outside the application's form and component tree.
  for (const [property, value] of Object.entries({ all: "initial", position: "fixed", inset: "0", width: "auto", height: "auto",
    margin: "0", padding: "0", border: "0", transform: "none", "pointer-events": "none", "z-index": "2147483647", contain: "strict" })) host.style.setProperty(property, value, "important")
  const shadow = host.attachShadow({ mode: "open" })
  const style = document.createElement("style")
  style.textContent = `*{box-sizing:border-box} [hidden]{display:none!important}
    .annotation{position:absolute;font:12px/1.5 system-ui;color:#14532d;pointer-events:none}
    button{font:inherit;cursor:pointer;background:#f0fdf4;border:1px solid #86efac;border-radius:4px;padding:2px 6px;color:#14532d;pointer-events:auto;white-space:nowrap}
    .conflict button{background:#fffbeb;border-color:#fcd34d;color:#92400e}
    .outline{position:absolute;border:2px solid #86efac;background:rgba(134,239,172,.08);pointer-events:none}
    .outline.conflict{border-color:#f59e0b;background:rgba(245,158,11,.08)}
    aside{position:relative;z-index:1;width:400px;max-width:100%;padding:6px;background:#fff;border:1px solid #cbd5e1;white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto;color:#17201d;pointer-events:auto}`
  shadow.append(style)
  document.body.append(host)
  view.addEventListener("scroll", schedule, true)
  view.addEventListener("resize", schedule)
  const clear = () => {
    for (const annotation of annotations.values()) if (annotation.control.elements[0].ownerDocument === document) remove(annotation)
    cleanup()
  }
  view.addEventListener("pagehide", clear)
  view.addEventListener("popstate", clear)
  const overlay = { host, shadow, dispose: () => {
    view.removeEventListener("scroll", schedule, true); view.removeEventListener("resize", schedule)
    view.removeEventListener("pagehide", clear); view.removeEventListener("popstate", clear)
  } }
  overlays.set(document, overlay)
  return overlay
}
export function clearSourceAnnotations(sessionId?: string): void {
  for (const annotation of annotations.values()) if (!sessionId || annotation.mark.sessionId === sessionId) remove(annotation)
  cleanup()
}
export function toggleSourceEvidence(sessionId: string, visible: boolean): void {
  for (const annotation of annotations.values()) if (annotation.mark.sessionId === sessionId) {
    annotation.evidence.hidden = !visible; annotation.badge.setAttribute("aria-expanded", String(visible))
  }
  schedule()
}
export function pruneSourceAnnotations(pageIdentity: string): void {
  for (const annotation of annotations.values()) if (annotation.mark.pageIdentity !== pageIdentity) remove(annotation)
  cleanup()
}
export function markSourceReview(mark: SourceReviewMark, control: Control): boolean {
  const previous = annotations.get(key(mark))
  if (previous) remove(previous)
  const document = control.elements[0].ownerDocument
  const overlay = overlayFor(document)
  const host = document.createElement("div")
  host.className = mark.status === "conflict" ? "annotation conflict" : "annotation"
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
  }
  const outlines = control.elements.map(() => {
    const outline = document.createElement("div")
    outline.className = mark.status === "conflict" ? "outline conflict" : "outline"
    overlay.shadow.append(outline)
    return outline
  })
  host.append(badge, evidence)
  overlay.shadow.append(host)
  badge.addEventListener("click", (event) => {
    event.preventDefault(); event.stopPropagation()
    evidence.hidden = !evidence.hidden; badge.setAttribute("aria-expanded", String(!evidence.hidden)); schedule()
  })
  const annotation: Annotation = { mark, host, control, evidence, badge, outlines, url: document.URL }
  annotations.set(key(mark), annotation)
  position(annotation)
  timer ??= setInterval(reposition, 250)
  return annotations.has(key(mark))
}
