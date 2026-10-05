import "fake-indexeddb/auto"

import { matchFieldsWithBuiltinApi } from "./builtin-api-field-matcher"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  BUILTIN_API_MODELS,
  DirectApiProvider,
  builtinApiHealth,
  builtinApiModel,
  builtinApiModelConfig,
  configureBuiltinApiModel,
  clearBuiltinApiModels,
  removeBuiltinApiModel,
} from "./direct-api-provider"

type StorageValues = Record<string, unknown>

function storageArea(values: StorageValues) {
  return {
    async get(key: string) { return { [key]: values[key] } },
    async set(input: StorageValues) { Object.assign(values, input) },
    async remove(key: string) { delete values[key] },
    async setAccessLevel() {},
  }
}

const sessionValues: StorageValues = {}
const localValues: StorageValues = {}

vi.stubGlobal("chrome", {
  storage: {
    session: storageArea(sessionValues),
    local: storageArea(localValues),
  },
})

const request = {
  task: "field_match" as const,
  system: "Match fields",
  input: "Source and target fields",
  schema: { type: "object" },
  maxTokens: 512,
}

describe("direct API providers", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.stubGlobal("chrome", {
      storage: {
        session: storageArea(sessionValues),
        local: storageArea(localValues),
      },
    })
    for (const key of Object.keys(sessionValues)) delete sessionValues[key]
    for (const key of Object.keys(localValues)) delete localValues[key]
  })

  it.each(BUILTIN_API_MODELS)("$displayName defaults to a supported recommended model", async (definition) => {
    const option = definition.models.find((model) => model.id === definition.defaultModel)
    expect(option).toMatchObject({
      recommended: true,
      costTier: definition.defaultReason === "free_tier" ? "free" : "lowest_cost",
    })
    expect(new Set(definition.models.map((model) => model.id)).size).toBe(definition.models.length)
    expect(await builtinApiModelConfig(definition.id)).toMatchObject({
      model: definition.defaultModel, configured: false, hasKey: false,
    })
  })

  it.each(BUILTIN_API_MODELS)("rejects unsupported $displayName models before storing a key", async (definition) => {
    await expect(configureBuiltinApiModel({
      modelId: definition.id, model: "unknown-model", apiKey: "unsaved-key", rememberKey: false,
    })).rejects.toThrow(`Choose a supported ${definition.displayName} model`)
    expect(sessionValues).toEqual({})
    expect(localValues).toEqual({})
    expect(() => new DirectApiProvider(definition, "unknown-model")).toThrow("Choose a supported")
  })

  it.each(["deepseek-v4-flash", "deepseek-v41-flash", "deepseek-v4-flash-vision-exp"])("migrates %s in the existing storage schema", async (model) => {
    localValues.rekeyzeroPersonalApiModelConfigs = { "personal-deepseek-api-v1": { model, rememberKey: false } }
    expect(await builtinApiModelConfig("personal-deepseek-api-v1")).toMatchObject({ model: "deepseek-flash", configured: true })
    expect(localValues.rekeyzeroPersonalApiModelConfigs).toEqual({
      "personal-deepseek-api-v1": { model: "deepseek-flash", rememberKey: false },
    })
  })

  it("normalizes all stored providers together and preserves supported choices", async () => {
    localValues.rekeyzeroPersonalApiModelConfigs = {
      "personal-gemini-api-v1": { model: "gemini-3.5-flash", rememberKey: false },
      "personal-gpt-api-v1": { model: "gpt-5.6-terra", rememberKey: false },
      "personal-deepseek-api-v1": { model: "deepseek-v4-flash", rememberKey: false },
      "personal-claude-api-v1": { model: "retired-preview", rememberKey: false },
    }
    const configs = await Promise.all(BUILTIN_API_MODELS.map((definition) => builtinApiModelConfig(definition.id)))
    expect(configs.map((config) => config.model)).toEqual([
      "gemini-3.5-flash", "gpt-5.6-terra", "claude-haiku-4-5", "deepseek-flash",
    ])
    expect(localValues.rekeyzeroPersonalApiModelConfigs).toMatchObject({
      "personal-gpt-api-v1": { model: "gpt-5.6-terra" },
      "personal-claude-api-v1": { model: "claude-haiku-4-5" },
    })
  })

  it.each(["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"])("sends the selected OpenAI model %s", async (model) => {
    const definition = builtinApiModel("personal-gpt-api-v1")
    await configureBuiltinApiModel({ modelId: definition.id, model, apiKey: "fixture-key", rememberKey: false })
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] })))
    vi.stubGlobal("fetch", fetchMock)
    await new DirectApiProvider(definition, model).completeJson(request)
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).model).toBe(model)
  })

  it.each(["claude-haiku-4-5", "claude-sonnet-5-5", "claude-opus-5-5"])("calls Claude Messages with %s and parses only text blocks", async (model) => {
    const definition = builtinApiModel("personal-claude-api-v1")
    await configureBuiltinApiModel({ modelId: definition.id, model, apiKey: "claude-user-secret", rememberKey: false })
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      content: [{ type: "thinking", text: "ignore" }, { type: "text", text: '{"decisions":' }, { type: "text", text: "[]}" }],
      stop_reason: "end_turn",
    })))
    vi.stubGlobal("fetch", fetchMock)
    const signal = new AbortController().signal
    const schema = { type: "object", additionalProperties: false, required: ["decisions"], properties: {
      decisions: { type: "array", minItems: 3, maxItems: 3, items: { type: "object", properties: {
        minItems: { type: "string" },
      }, additionalProperties: false } },
    } }
    expect(await new DirectApiProvider(definition, model).completeJson({ ...request, schema }, signal)).toMatchObject({
      modelId: model, output: { decisions: [] },
    })
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://api.anthropic.com/v1/messages")
    expect(options.signal).toBe(signal)
    expect(options.headers).toMatchObject({ Authorization: "Bearer claude-user-secret", "anthropic-version": "2023-06-01" })
    const body = JSON.parse(String(options.body))
    expect(body).toMatchObject({ model, max_tokens: 1024, messages: [{ role: "user", content: request.input }],
      output_config: { format: { type: "json_schema", schema: { properties: { decisions: {
        minItems: 1, description: "At least 3 items. At most 3 items.", items: { properties: { minItems: { type: "string" } } },
      } } } } },
    })
    expect(body.output_config.format.schema.properties.decisions).not.toHaveProperty("maxItems")
    expect(body.system).toContain(JSON.stringify(schema))
    expect(schema.properties.decisions).toMatchObject({ minItems: 3, maxItems: 3 })
    expect(body).not.toHaveProperty("thinking")
    expect(String(options.body)).not.toContain("claude-user-secret")
    expect(JSON.stringify(localValues)).not.toContain("claude-user-secret")
  })

  it.each([401, 403, 429, 503])("handles Claude HTTP %s without retrying provider errors", async (status) => {
    const definition = builtinApiModel("personal-claude-api-v1")
    await configureBuiltinApiModel({ modelId: definition.id, model: definition.defaultModel, apiKey: "fixture-key", rememberKey: false })
    const fetchMock = vi.fn().mockResolvedValue(new Response("provider-error", { status }))
    vi.stubGlobal("fetch", fetchMock)
    const message = status === 401 || status === 403 ? "Claude rejected the API key"
      : status === 429 ? "Claude rate limit was reached" : "Claude returned HTTP 503"
    await expect(new DirectApiProvider(definition, definition.defaultModel).completeJson(request)).rejects.toThrow(message)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("rejects an empty Claude response", async () => {
    const definition = builtinApiModel("personal-claude-api-v1")
    await configureBuiltinApiModel({ modelId: definition.id, model: definition.defaultModel, apiKey: "fixture-key", rememberKey: false })
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ content: [], stop_reason: "refusal" }))))
    await expect(new DirectApiProvider(definition, definition.defaultModel).completeJson(request)).rejects.toThrow("Claude returned no content")
  })

  it.each(BUILTIN_API_MODELS)("resets $displayName to its default and clears its session key", async (definition) => {
    await configureBuiltinApiModel({ modelId: definition.id, model: definition.models.at(-1)!.id, apiKey: "fixture-key", rememberKey: false })
    await removeBuiltinApiModel(definition.id)
    expect(await builtinApiModelConfig(definition.id)).toMatchObject({ model: definition.defaultModel, configured: false, hasKey: false })
  })

  it("clears all provider configs and session keys, including Claude", async () => {
    for (const definition of BUILTIN_API_MODELS) {
      await configureBuiltinApiModel({ modelId: definition.id, model: definition.defaultModel, apiKey: "fixture-key", rememberKey: false })
    }
    await clearBuiltinApiModels()
    expect(localValues).not.toHaveProperty("rekeyzeroPersonalApiModelConfigs")
    for (const definition of BUILTIN_API_MODELS) {
      expect(await builtinApiModelConfig(definition.id)).toMatchObject({ configured: false, hasKey: false })
    }
  })

  it("requires the user to enter a key in the extension UI", async () => {
    await expect(builtinApiHealth("personal-gemini-api-v1")).resolves.toMatchObject({
      status: "not_ready",
      detail: expect.stringContaining("extension UI"),
    })
  })

  it("calls Gemini directly without putting the key in the URL or request body", async () => {
    await configureBuiltinApiModel({
      modelId: "personal-gemini-api-v1",
      model: "gemini-3.6-flash",
      rememberKey: false,
      apiKey: "gemini-user-secret",
    })
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "{\"decisions\":[]}" }] } }],
    }), { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)

    const definition = builtinApiModel("personal-gemini-api-v1")
    const config = await builtinApiModelConfig(definition.id)
    const result = await new DirectApiProvider(definition, config.model).completeJson(request)

    expect(result).toMatchObject({ output: { decisions: [] }, modelId: "gemini-3.6-flash" })
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent")
    expect(url).not.toContain("gemini-user-secret")
    expect(options.headers).toMatchObject({ "x-goog-api-key": "gemini-user-secret" })
    expect(String(options.body)).not.toContain("gemini-user-secret")
  })

  it("calls DeepSeek directly with the user-selected model", async () => {
    await configureBuiltinApiModel({
      modelId: "personal-deepseek-api-v1",
      model: "deepseek-v4-pro",
      rememberKey: true,
      apiKey: "deepseek-user-secret",
    })
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "{\"decisions\":[]}" }, finish_reason: "stop" }],
    }), { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)

    const definition = builtinApiModel("personal-deepseek-api-v1")
    const config = await builtinApiModelConfig(definition.id)
    const result = await new DirectApiProvider(definition, config.model).completeJson(request)

    expect(result).toMatchObject({ output: { decisions: [] }, modelId: "deepseek-v4-pro" })
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://api.deepseek.com/chat/completions")
    expect(options.headers).toMatchObject({ Authorization: "Bearer deepseek-user-secret" })
    expect(JSON.parse(String(options.body))).toMatchObject({ model: "deepseek-v4-pro" })
  })

  it("calls OpenAI directly with the default GPT model contract", async () => {
    await configureBuiltinApiModel({
      modelId: "personal-gpt-api-v1",
      model: "gpt-5.6-terra",
      rememberKey: false,
      apiKey: "openai-user-secret",
    })
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "{\"decisions\":[]}" }, finish_reason: "stop" }],
    }), { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)

    const definition = builtinApiModel("personal-gpt-api-v1")
    const config = await builtinApiModelConfig(definition.id)
    const result = await new DirectApiProvider(definition, config.model).completeJson(request)

    expect(result).toMatchObject({ output: { decisions: [] }, modelId: "gpt-5.6-terra" })
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://api.openai.com/v1/chat/completions")
    expect(options.headers).toMatchObject({ Authorization: "Bearer openai-user-secret" })
    expect(JSON.parse(String(options.body))).toMatchObject({
      model: "gpt-5.6-terra",
      max_completion_tokens: 1024,
      response_format: { type: "json_object" },
    })
  })

  it("removes the configured model and credential", async () => {
    await configureBuiltinApiModel({
      modelId: "personal-deepseek-api-v1",
      model: "deepseek-v4-pro",
      rememberKey: true,
      apiKey: "deepseek-user-secret",
    })

    await removeBuiltinApiModel("personal-deepseek-api-v1")

    await expect(builtinApiModelConfig("personal-deepseek-api-v1")).resolves.toMatchObject({
      model: "deepseek-flash",
      configured: false,
      hasKey: false,
    })
  })

  it.each(["personal-gemini-api-v1", "personal-deepseek-api-v1", "personal-gpt-api-v1", "personal-claude-api-v1"])(
    "%s never serializes source or target runtime values, including retries",
    async (modelId) => {
      await configureBuiltinApiModel({ modelId, model: builtinApiModel(modelId).defaultModel, rememberKey: true, apiKey: "fixture-key" })
      const definition = builtinApiModel(modelId)
      const response = (text: string) => new Response(JSON.stringify(definition.provider === "gemini"
        ? { candidates: [{ content: { parts: [{ text }] } }] }
        : definition.protocol === "anthropic" ? { content: [{ type: "text", text }] } : { choices: [{ message: { content: text } }] }), { status: 200 })
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(response("invalid JSON"))
        .mockResolvedValueOnce(response('{"decisions":[{"target":"Destination beta field","source":null}]}'))
      vi.stubGlobal("fetch", fetchMock)
      await matchFieldsWithBuiltinApi({
        modelId,
        controls: [{
          control_id: "target", tag: "input", type: "text", role: "", name: "target",
          label: "Destination beta field", placeholder: "", required: false, disabled: false,
          current_value: "PRIVATE_TARGET_7924", checked: null, options: [],
        }],
        candidates: [
          { information_path: "source", label_text: "Origin alpha field", type: "text", value: "PRIVATE_SOURCE_8317" },
          { information_path: "numeric", label_text: "Origin gamma field", type: "number", value: 9876543210123 },
        ],
      })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      for (const [, options] of fetchMock.mock.calls) {
        const body = String(options.body)
        expect(body).toContain("Origin alpha field")
        expect(body).not.toContain("PRIVATE_SOURCE_8317")
        expect(body).not.toContain("PRIVATE_TARGET_7924")
        expect(body).not.toContain("9876543210123")
      }
      expect(JSON.stringify(localValues)).not.toContain("fixture-key")
      expect(await builtinApiModelConfig(modelId)).toMatchObject({ rememberKey: false, hasKey: true })
    },
  )

  it("migrates a remembered built-in credential once and removes the durable key", async () => {
    const modelId = "personal-gemini-api-v1"
    localValues[`personalRememberedProviderKey:${modelId}`] = {
      origin: "https://generativelanguage.googleapis.com", apiKey: "legacy-fixture-key",
    }
    localValues.rekeyzeroPersonalApiModelConfigs = { [modelId]: { model: "fixture-model", rememberKey: true } }
    expect(await builtinApiModelConfig(modelId)).toMatchObject({ hasKey: true, rememberKey: false })
    expect(JSON.stringify(localValues)).not.toContain("legacy-fixture-key")
    for (const key of Object.keys(sessionValues)) delete sessionValues[key]
    expect(await builtinApiModelConfig(modelId)).toMatchObject({ hasKey: false })
  })

})
