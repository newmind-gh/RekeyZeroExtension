import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { processPrivacy, PRIVACY_PROCESSING_ERROR } from "./privacy-processor"
import { extractSourceFields } from "./source-extractor"
import type { PersonalModelProvider } from "../ai/model-provider"

class WorkerFixture {
  static instance: WorkerFixture
  onmessage?: (event: { data: unknown }) => void
  onerror?: () => void
  onmessageerror?: () => void
  message?: { id: number; markdown: string }
  terminate = vi.fn()
  constructor() { WorkerFixture.instance = this }
  postMessage(message: { id: number; markdown: string }) { this.message = message }
}
beforeEach(() => { vi.stubGlobal("Worker", WorkerFixture) })
afterEach(() => { WorkerFixture.instance?.onerror?.(); vi.unstubAllGlobals(); vi.useRealTimers() })

it.each(["model load failure", "WASM failure", "DocCloak error", "AU recognizer exception", "worker crash", "invalid result", "timeout"])(
  "%s fails closed without exposing an error or calling a provider", async (failure) => {
    vi.useFakeTimers()
    const completeJson = vi.fn()
    const provider = { completeJson } as unknown as PersonalModelProvider
    const outbound = async () => {
      const markdown = "PRIVATE_DOCUMENT_CONTENT"
      const privacy = await processPrivacy(markdown)
      return extractSourceFields(provider, [], [{ id: "doc", name: "input.txt", size: 10, mediaType: "text/plain",
        markdown, privacy, textHash: "a".repeat(64) }], new AbortController().signal)
    }
    const result = expect(outbound()).rejects.toThrow(PRIVACY_PROCESSING_ERROR)
    const instance = WorkerFixture.instance
    if (failure === "worker crash") instance.onerror?.()
    else if (failure === "timeout") await vi.advanceTimersByTimeAsync(300_000)
    else instance.onmessage?.({ data: { id: instance.message!.id, type: failure === "invalid result" ? "result" : "error",
      result: { redactedMarkdown: 42 }, error: "PRIVATE_DOCUMENT_ERROR" } })
    await result
    expect(instance.terminate).toHaveBeenCalled()
    expect(completeJson).not.toHaveBeenCalled()
  })

it("reuses one worker and retains the trusted map but discards additional finding fields in valid output", async () => {
  const first = processPrivacy("Document A")
  const instance = WorkerFixture.instance
  instance.onmessage?.({ data: { type: "result", id: instance.message!.id, result: { redactedMarkdown: "[PERSON_1]",
    findings: [{ type: "PERSON", displayName: "Name", placeholder: "[PERSON_1]", value: "PRIVATE_VALUE" }], entityMap: { "[PERSON_1]": "PRIVATE_VALUE" } } } })
  const prepared = await first
  expect(JSON.stringify(prepared.findings)).not.toContain("PRIVATE_VALUE")
  expect(prepared.entityMap).toEqual({ "[PERSON_1]": "PRIVATE_VALUE" })
  const second = processPrivacy("Document B")
  expect(WorkerFixture.instance).toBe(instance)
  instance.onmessage?.({ data: { type: "result", id: instance.message!.id, result: { redactedMarkdown: "Document B", findings: [], entityMap: {} } } })
  expect((await second).redactedMarkdown).toBe("Document B")
})

it("returns a safe error and never supplies failed privacy output to a provider", async () => {
  const completeJson = vi.fn()
  const provider = { completeJson } as unknown as PersonalModelProvider
  const incomplete = [{ id: "doc", name: "input.txt", size: 10, mediaType: "text/plain",
    markdown: "PRIVATE_DOCUMENT_CONTENT", textHash: "a".repeat(64) }]
  await expect(extractSourceFields(provider, [], incomplete as never, new AbortController().signal)).rejects.toThrow(PRIVACY_PROCESSING_ERROR)
  expect(completeJson).not.toHaveBeenCalled()
})
