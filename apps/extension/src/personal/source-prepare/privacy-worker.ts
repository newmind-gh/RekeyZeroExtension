import { createPrivacyEngine } from "./privacy-engine"

const scope = self as unknown as { location: Location; postMessage: (message: unknown) => void; onmessage: ((event: MessageEvent) => void) | null }
const engine = createPrivacyEngine(new URL("../privacy-runtime/", scope.location.href).href,
  (message) => scope.postMessage({ type: "progress", message }))
let queue = Promise.resolve()
scope.onmessage = (event: MessageEvent<{ id: number; markdown: string }>) => {
  const { id, markdown } = event.data
  queue = queue.then(async () => {
    try {
      if (!Number.isInteger(id) || typeof markdown !== "string" || !markdown.trim() || markdown.length > 80_000) throw new Error("Invalid privacy input")
      const result = await engine.process(markdown)
      scope.postMessage({ type: "result", id, result })
    } catch { scope.postMessage({ type: "error", id }) }
  })
}
