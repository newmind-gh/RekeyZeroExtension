import { beforeEach, describe, expect, it, vi } from "vitest"
import { BUILTIN_API_MODELS, DirectApiProvider, configureBuiltinApiModel } from "../ai/direct-api-provider"
import { extractSourceFields } from "./source-extractor"
import type { PreparedDocument } from "./source-prepare-session"
import { redactPrivacyEntities } from "./privacy-engine"
import type { DetectedEntity, EntityType } from "@doccloak/core"
import { LOCAL_MODELS } from "../ai/model-registry"
import type { ModelRequest, PersonalModelProvider } from "../ai/model-provider"

const local: Record<string, unknown> = {}, session: Record<string, unknown> = {}
const storage = (values: Record<string, unknown>) => ({
  get: async (key: string) => ({ [key]: values[key] }), set: async (input: Record<string, unknown>) => Object.assign(values, input),
  remove: async (key: string) => { delete values[key] }, setAccessLevel: async () => {},
})
const documents: PreparedDocument[] = [{ id: "doc", name: "evidence.txt", mediaType: "text/plain", size: 50, textHash: "a".repeat(64), markdown: "Organisation: PRIVATE_DOCUMENT_4431", privacy: { findings: [], entityMap: {}, redactedMarkdown: "Organisation: PRIVATE_DOCUMENT_4431" } }]
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
    const markdown = "Organisation: Example Pty Ltd\nApplicant: John Smith\nAddress: 12 George Street, Sydney NSW 2000\nEmail: customer@example.com\nPhone: +61 412 345 678\nCard: 4111 1111 1111 1111\nIBAN: GB82 WEST 1234 5698 7654 32\nIP: 192.168.1.10\nTFN: 123 456 782\nMedicare: 2123 45670 1\nABN: 51 824 753 556\nACN: 004 085 616\nAPI key: sk-" + "a".repeat(48)
      + "\nAnnual turnover: $12,500,000\nBuilding sum insured: $8,500,000\nPremium: $42,500\nPolicy expiry: 30 June 2027"
    // Golden semantic spans isolate the provider boundary from model accuracy;
    // packaged browser tests separately run real GLiNER inference.
    const semantic: DetectedEntity[] = ([["John Smith", "PERSON"], ["12 George Street, Sydney NSW 2000", "ADDRESS"]] as Array<[string, EntityType]>).map(([value, type]) => ({
      type, value, start: markdown.indexOf(value), end: markdown.indexOf(value) + value.length, detector: "gliner:fixture", confidence: 0.9,
    }))
    const privacy = redactPrivacyEntities(markdown, semantic)
    const prepared = [{ ...documents[0], markdown, privacy }]
    const result = await extractSourceFields(new DirectApiProvider(definition, definition.defaultModel), fields, prepared, new AbortController().signal)
    expect(result).toEqual({ decisions })
    const [url, options] = fetch.mock.calls[0]
    expect(`${url}${options.body}`).not.toContain("PRIVATE_API_FIXTURE_KEY")
    expect(String(options.body)).toContain("Example Pty Ltd")
    expect(String(options.body)).not.toContain("customer@example.com")
    for (const value of ["John Smith", "12 George Street", "+61 412 345 678", "4111 1111 1111 1111", "GB82 WEST 1234 5698 7654 32",
      "192.168.1.10", "123 456 782", "2123 45670 1", "51 824 753 556", "004 085 616", "sk-" + "a".repeat(48)]) {
      expect(String(options.body)).not.toContain(value)
    }
    for (const value of ["$12,500,000", "$8,500,000", "$42,500", "30 June 2027"]) expect(String(options.body)).toContain(value)
    expect(String(options.body)).not.toContain("findings")
    for (const finding of privacy.findings) expect(String(options.body)).toContain(finding.placeholder)
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

describe("source extraction with the selected local model", () => {
  it.each(LOCAL_MODELS)("$displayName extracts each field locally with all redacted evidence", async (model) => {
    expect(model.supportedTasks).toEqual(expect.arrayContaining(["field_match", "source_extract"]))
    const completeJson = vi.fn(async (request: ModelRequest) => {
      const input = request.input as { fields: typeof fields }
      return { output: { decisions: input.fields.map((field) => ({ fieldKey: field.fieldKey, value: null, status: "not_found", evidence: [] })) },
        providerId: "personal-local-lite", modelId: model.id, rawResponses: [] }
    })
    const provider = { id: model.id, kind: "browser_local", health: async () => ({ status: "ready" }), completeJson } as unknown as PersonalModelProvider
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const twoFields = [...fields, { ...fields[0], fieldKey: "field_002", label: "Trading name" }]
    const result = await extractSourceFields(provider, twoFields, documents, new AbortController().signal)
    expect(result).toEqual({ decisions: twoFields.map((field) => ({ fieldKey: field.fieldKey, value: null, status: "not_found", evidence: [] })) })
    expect(completeJson).toHaveBeenCalledTimes(2)
    for (const [request] of completeJson.mock.calls) {
      expect(request.task).toBe("source_extract")
      expect(request.maxTokens).toBe(512)
      expect(request.input).toMatchObject({ documents: [{ documentId: "doc", markdown: documents[0].privacy.redactedMarkdown }] })
      expect((request.input as { fields: unknown[] }).fields).toHaveLength(1)
    }
    expect(fetch).not.toHaveBeenCalled()
  })
})
