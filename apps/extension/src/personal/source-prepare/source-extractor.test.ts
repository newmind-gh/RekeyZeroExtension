import { beforeEach, describe, expect, it, vi } from "vitest"
import { BUILTIN_API_MODELS, DirectApiProvider, configureBuiltinApiModel } from "../ai/direct-api-provider"
import { extractSourceFields } from "./source-extractor"
import { parseSourceDocument } from "./document-parser"
import type { ParsedDocument } from "./source-prepare-session"

const local: Record<string, unknown> = {}, session: Record<string, unknown> = {}
const storage = (values: Record<string, unknown>) => ({
  get: async (key: string) => ({ [key]: values[key] }), set: async (input: Record<string, unknown>) => Object.assign(values, input),
  remove: async (key: string) => { delete values[key] }, setAccessLevel: async () => {},
})
const documents: ParsedDocument[] = [{ id: "doc", name: "evidence.txt", mediaType: "text/plain", size: 50, textHash: "a".repeat(64), pages: [{ text: "Organisation: PRIVATE_DOCUMENT_4431" }] }]
const fields = [{ fieldKey: "field_001", label: "Organisation name", section: "Organisation", controlType: "text", required: true, options: [] }]
beforeEach(() => {
  vi.unstubAllGlobals()
  for (const key of Object.keys(local)) delete local[key]
  for (const key of Object.keys(session)) delete session[key]
  vi.stubGlobal("chrome", { storage: { local: storage(local), session: storage(session) } })
})
describe("source extraction across direct API providers", () => {
  it.each(BUILTIN_API_MODELS)("$displayName shares its configured model and transmits document text without its API key", async (definition) => {
    expect(definition.supportedTasks).toContain("source_extract")
    await configureBuiltinApiModel({ modelId: definition.id, model: definition.defaultModel, rememberKey: false, apiKey: "PRIVATE_API_FIXTURE_KEY" })
    const decisions = [{ fieldKey: "field_001", value: "PRIVATE_DOCUMENT_4431", status: "found", evidence: [{ documentId: "doc", page: null, quote: "Organisation: PRIVATE_DOCUMENT_4431" }] }]
    const response = JSON.stringify({ decisions })
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(definition.protocol === "gemini"
      ? { candidates: [{ content: { parts: [{ text: response }] } }] }
      : definition.protocol === "anthropic" ? { content: [{ type: "text", text: response }] }
      : { choices: [{ message: { content: response } }] })))
    vi.stubGlobal("fetch", fetch)
    const result = await extractSourceFields(new DirectApiProvider(definition, definition.defaultModel), fields, documents, new AbortController().signal)
    expect(result).toEqual({ decisions })
    const [url, options] = fetch.mock.calls[0]
    expect(`${url}${options.body}`).not.toContain("PRIVATE_API_FIXTURE_KEY")
    expect(String(options.body)).toContain("PRIVATE_DOCUMENT_4431")
    expect(JSON.stringify(local)).not.toContain("PRIVATE_DOCUMENT_4431")
    expect(JSON.stringify(local)).not.toContain("PRIVATE_API_FIXTURE_KEY")
  })
  it.each(BUILTIN_API_MODELS)("$displayName does not include raw extraction output in malformed-JSON errors", async (definition) => {
    await configureBuiltinApiModel({ modelId: definition.id, model: definition.defaultModel, rememberKey: false, apiKey: "fixture-key" })
    const text = "PRIVATE_DOCUMENT_4431 invalid JSON"
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(JSON.stringify(definition.protocol === "gemini"
      ? { candidates: [{ content: { parts: [{ text }] } }] }
      : definition.protocol === "anthropic" ? { content: [{ type: "text", text }] }
      : { choices: [{ message: { content: text } }] }))))
    await expect(extractSourceFields(new DirectApiProvider(definition, definition.defaultModel), fields, documents, new AbortController().signal)).rejects.toThrow("AI returned invalid extraction JSON twice")
  })
})
describe("local text document parsing", () => {
  it.each(["application.txt", "application.md", "application.markdown"])("parses %s without treating its content as code", async (name) => {
    const file = new File(["Organisation: Example\n<script>alert(1)</script>"], name, { type: "text/plain" })
    const parsed = await parseSourceDocument(file)
    expect(parsed.pages[0].text).toContain("<script>alert(1)</script>")
    expect(parsed.textHash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(local)).not.toContain("Organisation: Example")
  })
  it("rejects empty, unsupported, and oversized text documents", async () => {
    await expect(parseSourceDocument(new File([], "empty.txt"))).rejects.toThrow("between 1 byte and 10 MB")
    await expect(parseSourceDocument(new File(["content"], "file.html"))).rejects.toThrow("Use TXT")
    await expect(parseSourceDocument(new File(["x".repeat(80_001)], "big.txt"))).rejects.toThrow("too large")
  })
})
