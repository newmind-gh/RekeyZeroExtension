// Traversal discovers controls; adapters alone interpret or write them.
export type DomScope = { root: Document | ShadowRoot; path: string; token: string; url: string; connected: () => boolean }
const tokens = new WeakMap<Node, string>()
function token(node: Node): string {
  if (!tokens.has(node)) tokens.set(node, crypto.randomUUID())
  return tokens.get(node)!
}
export function discoverDomScopes(): { scopes: DomScope[]; limited: boolean } {
  const scopes: DomScope[] = []
  let limited = false
  let count = 0
  function walk(root: Document | ShadowRoot, path: string, connected: () => boolean, depth: number) {
    if (depth > 8 || scopes.length >= 32) { limited = true; return }
    scopes.push({ root, path, token: token(root), url: (root.nodeType === 9 ? root as Document : root.ownerDocument!).URL, connected })
    const nodes = root.querySelectorAll("*")
    for (const [index, element] of Array.from(nodes).entries()) {
      if (++count > 20_000) { limited = true; return }
      const identity = element.id || element.getAttribute("name") || `${element.tagName.toLowerCase()}-${index}`
      if (element.shadowRoot) {
        const shadow = element.shadowRoot
        walk(shadow, `${path}/shadow:${identity}`, () => connected() && element.isConnected && element.shadowRoot === shadow, depth + 1)
      }
      if (element.tagName === "IFRAME") {
        const frame = element as HTMLIFrameElement
        try {
          const child = frame.contentDocument
          const url = frame.contentWindow?.location.href
          // Sandbox and cross-origin frames are excluded. No additional permission is inferred.
          if (frame.hasAttribute("sandbox") || !child || !url || new URL(url).origin !== location.origin) continue
          walk(child, `${path}/frame:${identity}:${new URL(url).pathname.split("/").filter(Boolean).map(() => ":segment").join("/")}`, () => connected() && frame.isConnected && frame.contentDocument === child, depth + 1)
        } catch { /* Cross-origin frames are outside this observation. */ }
      }
    }
  }
  walk(document, "", () => true, 0)
  return { scopes, limited }
}
export function scopeVisible(element: Element): boolean {
  if (element.closest('[hidden], [inert], [aria-hidden="true"]') || !element.getClientRects().length || element.ownerDocument.defaultView?.getComputedStyle(element).visibility === "hidden") return false
  const root = element.getRootNode()
  if ((root as ShadowRoot).host && !scopeVisible((root as ShadowRoot).host)) return false
  const frame = element.ownerDocument.defaultView?.frameElement
  return !frame || scopeVisible(frame)
}
