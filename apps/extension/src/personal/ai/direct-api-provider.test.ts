import "fake-indexeddb/auto"

import { matchFieldsWithBuiltinApi } from "./builtin-api-field-matcher"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  DirectApiProvider,
  builtinApiHealth,
  builtinApiModel,
  builtinApiModelConfig,
  configureBuiltinApiModel,
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

  it("requires the user to enter a key in the extension UI", async () => {
    await expect(builtinApiHealth("personal-gemini-api-v1")).resolves.toMatchObject({
      status: "not_ready",
      detail: expect.stringContaining("extension UI"),
    })
  })

  it("calls Gemini directly without putting the key in the URL or request body", async () => {
    await configureBuiltinApiModel({
      modelId: "personal-gemini-api-v1",
      model: "gemini-test-model",
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

    expect(result).toMatchObject({ output: { decisions: [] }, modelId: "gemini-test-model" })
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-test-model:generateContent")
    expect(url).not.toContain("gemini-user-secret")
    expect(options.headers).toMatchObject({ "x-goog-api-key": "gemini-user-secret" })
    expect(String(options.body)).not.toContain("gemini-user-secret")
  })

  it("calls DeepSeek directly with the user-selected model", async () => {
    await configureBuiltinApiModel({
      modelId: "personal-deepseek-api-v1",
      model: "deepseek-test-model",
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

    expect(result).toMatchObject({ output: { decisions: [] }, modelId: "deepseek-test-model" })
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://api.deepseek.com/chat/completions")
    expect(options.headers).toMatchObject({ Authorization: "Bearer deepseek-user-secret" })
    expect(JSON.parse(String(options.body))).toMatchObject({ model: "deepseek-test-model" })
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
      model: "deepseek-test-model",
      rememberKey: true,
      apiKey: "deepseek-user-secret",
    })

    await removeBuiltinApiModel("personal-deepseek-api-v1")

    await expect(builtinApiModelConfig("personal-deepseek-api-v1")).resolves.toMatchObject({
      model: "deepseek-v4-flash",
      configured: false,
      hasKey: false,
    })
  })

  it.each(["personal-gemini-api-v1", "personal-deepseek-api-v1", "personal-gpt-api-v1"])(
    "%s never serializes source or target runtime values, including retries",
    async (modelId) => {
      await configureBuiltinApiModel({ modelId, model: "fixture-model", rememberKey: true, apiKey: "fixture-key" })
      const definition = builtinApiModel(modelId)
      const response = (text: string) => new Response(JSON.stringify(definition.provider === "gemini"
        ? { candidates: [{ content: { parts: [{ text }] } }] }
        : { choices: [{ message: { content: text } }] }), { status: 200 })
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
