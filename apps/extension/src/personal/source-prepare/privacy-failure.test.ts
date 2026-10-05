import { expect, it, vi } from "vitest"
import { processPrivacy, PRIVACY_PROCESSING_ERROR } from "./privacy-processor"
import { extractSourceFields } from "./source-extractor"
import type { PersonalModelProvider } from "../ai/model-provider"

vi.mock("@ossredact/core", () => ({ tier0Spans: () => { throw new Error("PRIVATE_DOCUMENT_ERROR") } }))

it("returns a safe error and never supplies failed privacy output to a provider", async () => {
  await expect(processPrivacy("PRIVATE_DOCUMENT_CONTENT")).rejects.toThrow(PRIVACY_PROCESSING_ERROR)
  const completeJson = vi.fn()
  const provider = { completeJson } as unknown as PersonalModelProvider
  const incomplete = [{ id: "doc", name: "input.txt", size: 10, mediaType: "text/plain",
    markdown: "PRIVATE_DOCUMENT_CONTENT", textHash: "a".repeat(64) }]
  await expect(extractSourceFields(provider, [], incomplete as never, new AbortController().signal)).rejects.toThrow(PRIVACY_PROCESSING_ERROR)
  expect(completeJson).not.toHaveBeenCalled()
})
