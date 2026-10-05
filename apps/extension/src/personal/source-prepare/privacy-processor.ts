import type { PrivacyResult } from "./source-prepare-session"
import { validPrivacyResult } from "./privacy-types"

export const PRIVACY_PROCESSING_ERROR = "Privacy processing could not complete. The document was not sent to the AI provider."
let worker: Worker | undefined
let sequence = 0
const pending = new Map<number, { resolve: (result: PrivacyResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
const listeners = new Set<(message: string) => void>()
export function onPrivacyProgress(listener: (message: string) => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener) }
}
function failWorker() {
  worker?.terminate(); worker = undefined
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error(PRIVACY_PROCESSING_ERROR)) }
  pending.clear()
}
function privacyWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL("./privacy-worker.ts", import.meta.url), { type: "module", name: "rekeyzero-privacy" })
  worker.onerror = failWorker
  worker.onmessageerror = failWorker
  worker.onmessage = (event: MessageEvent) => {
    const data = event.data
    if (data?.type === "progress") {
      for (const listener of listeners) listener(data.message === "Checking privacy locally…" ? data.message : "Loading verified local privacy model…")
      return
    }
    const request = pending.get(data?.id)
    if (!request) { failWorker(); return }
    const result = data.result
    if (data.type !== "result" || !validPrivacyResult(result)) {
      failWorker(); return
    }
    pending.delete(data.id); clearTimeout(request.timer)
    // The entity map crosses only this trusted local boundary, never provider input.
    request.resolve({ redactedMarkdown: result.redactedMarkdown,
      findings: result.findings.map(({ type, displayName, placeholder }) => ({ type, displayName, placeholder })),
      entityMap: { ...result.entityMap } })
  }
  return worker
}
export async function processPrivacy(markdown: string): Promise<PrivacyResult> {
  try {
    const instance = privacyWorker()
    return await new Promise<PrivacyResult>((resolve, reject) => {
      const id = ++sequence
      pending.set(id, { resolve, reject, timer: setTimeout(failWorker, 300_000) })
      try { instance.postMessage({ id, markdown }) } catch { failWorker() }
    })
  } catch { throw new Error(PRIVACY_PROCESSING_ERROR) }
}
