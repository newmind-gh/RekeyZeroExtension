import { afterAll, afterEach, describe, expect, it, vi } from "vitest"

const webLlm = vi.hoisted(() => ({
  createEngine: vi.fn(),
  deleteModel: vi.fn(),
  hasModel: vi.fn(),
}))

vi.mock("@mlc-ai/web-llm", () => ({
  CreateMLCEngine: webLlm.createEngine,
  deleteModelAllInfoInCache: webLlm.deleteModel,
  hasModelInCache: webLlm.hasModel,
}))

import { LocalModelProvider } from "./local-model-provider"

const singleFieldSchema = {
  type: "object",
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          target: { enum: ["Annual revenue | section: Merchant details"] },
          source: { enum: ["Annual turnover", null] },
        },
      },
    },
  },
}

describe("LocalModelProvider", () => {
  afterAll(() => vi.unstubAllGlobals())
  afterEach(async () => {
    await new LocalModelProvider("personal-qwen25-15b-v1").delete()
    await new LocalModelProvider("personal-gemma2-2b-it-v1").delete()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it("loads Qwen2.5 1.5B with WebLLM", async () => {
    vi.stubGlobal("navigator", { gpu: {} })
    const engine = {
      chat: { completions: { create: vi.fn().mockResolvedValue({ choices: [{ message: { content: '{\"ok\":true}' } }] }) } },
      reload: vi.fn().mockResolvedValue(undefined),
      unload: vi.fn().mockResolvedValue(undefined),
    }
    webLlm.createEngine.mockResolvedValue(engine)

    await new LocalModelProvider("personal-qwen25-15b-v1").load()

    expect(webLlm.createEngine).toHaveBeenCalledWith(
      "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
      expect.any(Object),
      { context_window_size: 4096 },
    )
  })

  it("loads Gemma 2 2B IT with WebLLM", async () => {
    vi.stubGlobal("navigator", { gpu: {} })
    const engine = {
      chat: { completions: { create: vi.fn().mockResolvedValue({ choices: [{ message: { content: '{\"ok\":true}' } }] }) } },
      reload: vi.fn().mockResolvedValue(undefined),
      unload: vi.fn().mockResolvedValue(undefined),
    }
    webLlm.createEngine.mockResolvedValue(engine)

    await new LocalModelProvider("personal-gemma2-2b-it-v1").load()

    expect(webLlm.createEngine).toHaveBeenCalledWith(
      "gemma-2-2b-it-q4f16_1-MLC",
      expect.any(Object),
      { context_window_size: 2048 },
    )
  })

  it("avoids WebLLM structured-output grammar while keeping deterministic completion options", async () => {
    vi.stubGlobal("navigator", { gpu: {} })
    const createCompletion = vi.fn().mockResolvedValue({ choices: [{ message: { content: '{\"ok\":true}' } }] })
    const engine = {
      chat: { completions: { create: createCompletion } },
      reload: vi.fn().mockResolvedValue(undefined),
      unload: vi.fn().mockResolvedValue(undefined),
    }
    webLlm.createEngine.mockResolvedValue(engine)

    const result = await new LocalModelProvider("personal-qwen25-15b-v1").completeJson<{ ok: boolean }>({
      task: "field_match",
      system: "Return JSON.",
      input: {},
      schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
    })

    expect(createCompletion).toHaveBeenCalledTimes(1)
    const request = createCompletion.mock.calls[0][0]
    expect(request).toEqual(expect.objectContaining({ temperature: 0, max_tokens: 512 }))
    expect(request).not.toHaveProperty("response_format")
    expect(request).not.toHaveProperty("enable_thinking")
    expect(result.output).toEqual({ ok: true })
  })

  it("uses compact field IDs in the WebLLM prompt without response_format", async () => {
    vi.stubGlobal("navigator", { gpu: {} })
    const createCompletion = vi.fn().mockResolvedValue({
      choices: [{ message: { content: '{"decisions":[{"target":"Registered business | section: Seller details","source":"Legal company name"}]}' } }],
    })
    const engine = {
      chat: { completions: { create: createCompletion } },
      reload: vi.fn().mockResolvedValue(undefined),
      unload: vi.fn().mockResolvedValue(undefined),
    }
    webLlm.createEngine.mockResolvedValue(engine)

    await new LocalModelProvider("personal-qwen25-15b-v1").completeJson({
      task: "field_match",
      system: "Match fields.",
      input: "fields",
      schema: {
        type: "object",
        properties: {
          decisions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                target: { enum: ["Registered business | section: Seller details"] },
                source: { enum: ["Legal company name", null] },
              },
            },
          },
        },
      },
    })

    const request = createCompletion.mock.calls[0][0]
    expect(request).not.toHaveProperty("response_format")
    expect(request.messages[0].content).toContain("compact IDs t1, t2")
    expect(request.messages[0].content).toContain('"target":"t1"')
    expect(request.messages[0].content).toContain('"source":"s1"')
    expect(request.messages[0].content).not.toContain('"Registered business | section: Seller details"')
  })

  it("canonicalizes a single valid field-match object without retrying", async () => {
    vi.stubGlobal("navigator", { gpu: {} })
    const raw = '{"target":"Annual revenue | section: Merchant details","source":"Annual turnover"}'
    const createCompletion = vi.fn().mockResolvedValue({ choices: [{ message: { content: raw } }] })
    const engine = {
      chat: { completions: { create: createCompletion } },
      reload: vi.fn().mockResolvedValue(undefined),
      unload: vi.fn().mockResolvedValue(undefined),
    }
    webLlm.createEngine.mockResolvedValue(engine)

    const result = await new LocalModelProvider("personal-qwen25-15b-v1").completeJson<{ decisions: Array<{ target: string; source: string | null }> }>({
      task: "field_match",
      system: "Match fields.",
      input: "fields",
      schema: singleFieldSchema,
    })

    expect(createCompletion).toHaveBeenCalledTimes(1)
    expect(result.rawResponses).toEqual([raw])
    expect(result.output.decisions).toEqual([
      { target: "Annual revenue | section: Merchant details", source: "Annual turnover" },
    ])
  })

  it("canonicalizes target_field/source_field without retrying", async () => {
    vi.stubGlobal("navigator", { gpu: {} })
    const raw = '{"target_field":"Annual revenue | section: Merchant details","source_field":"Annual turnover"}'
    const createCompletion = vi.fn().mockResolvedValue({ choices: [{ message: { content: raw } }] })
    const engine = {
      chat: { completions: { create: createCompletion } },
      reload: vi.fn().mockResolvedValue(undefined),
      unload: vi.fn().mockResolvedValue(undefined),
    }
    webLlm.createEngine.mockResolvedValue(engine)

    const result = await new LocalModelProvider("personal-qwen25-15b-v1").completeJson<{ decisions: Array<{ target: string; source: string | null }> }>({
      task: "field_match",
      system: "Match fields.",
      input: "fields",
      schema: singleFieldSchema,
    })

    expect(createCompletion).toHaveBeenCalledTimes(1)
    expect(result.output.decisions).toEqual([
      { target: "Annual revenue | section: Merchant details", source: "Annual turnover" },
    ])
  })

  it("canonicalizes compact IDs and common Gemma key names without retrying", async () => {
    vi.stubGlobal("navigator", { gpu: {} })
    const raw = '```json\n{"matches":[{"target_id":"t1","source_id":"s1"}]}\n```'
    const createCompletion = vi.fn().mockResolvedValue({ choices: [{ message: { content: raw } }] })
    const engine = {
      chat: { completions: { create: createCompletion } },
      reload: vi.fn().mockResolvedValue(undefined),
      unload: vi.fn().mockResolvedValue(undefined),
    }
    webLlm.createEngine.mockResolvedValue(engine)

    const result = await new LocalModelProvider("personal-gemma2-2b-it-v1").completeJson<{ decisions: Array<{ target: string; source: string | null }> }>({
      task: "field_match",
      system: "Match fields.",
      input: "Source fields:\n- s1: Annual turnover\nTarget fields:\n- t1: Annual revenue",
      schema: singleFieldSchema,
    })

    expect(createCompletion).toHaveBeenCalledTimes(1)
    expect(result.output.decisions).toEqual([
      { target: "Annual revenue | section: Merchant details", source: "Annual turnover" },
    ])
  })

  it("unwraps Gemma's single-element response array", async () => {
    vi.stubGlobal("navigator", { gpu: {} })
    const raw = '```json\n[{"decisions":[{"target":"t1","source":"s1"}]}]\n```'
    const createCompletion = vi.fn().mockResolvedValue({ choices: [{ message: { content: raw } }] })
    const engine = {
      chat: { completions: { create: createCompletion } },
      reload: vi.fn().mockResolvedValue(undefined),
      unload: vi.fn().mockResolvedValue(undefined),
    }
    webLlm.createEngine.mockResolvedValue(engine)

    const result = await new LocalModelProvider("personal-gemma2-2b-it-v1").completeJson<{ decisions: Array<{ target: string; source: string | null }> }>({
      task: "field_match",
      system: "Match fields.",
      input: "Source fields:\n- s1: Annual turnover\nTarget fields:\n- t1: Annual revenue",
      schema: singleFieldSchema,
    })

    expect(createCompletion).toHaveBeenCalledTimes(1)
    expect(result.output.decisions).toEqual([
      { target: "Annual revenue | section: Merchant details", source: "Annual turnover" },
    ])
  })

  it("fails closed to null when Gemma returns conflicting duplicates", async () => {
    vi.stubGlobal("navigator", { gpu: {} })
    const raw = '{"decisions":[{"target":"t1","source":"s1"},{"target":"t1","source":"null"}]}'
    const createCompletion = vi.fn().mockResolvedValue({ choices: [{ message: { content: raw } }] })
    const engine = {
      chat: { completions: { create: createCompletion } },
      reload: vi.fn().mockResolvedValue(undefined),
      unload: vi.fn().mockResolvedValue(undefined),
    }
    webLlm.createEngine.mockResolvedValue(engine)

    const result = await new LocalModelProvider("personal-gemma2-2b-it-v1").completeJson<{ decisions: Array<{ target: string; source: string | null }> }>({
      task: "field_match",
      system: "Match fields.",
      input: "fields",
      schema: singleFieldSchema,
    })

    expect(createCompletion).toHaveBeenCalledTimes(1)
    expect(result.output.decisions).toEqual([
      { target: "Annual revenue | section: Merchant details", source: null },
    ])
  })

  it("safely normalizes a unique shortened label and no-match text", async () => {
    vi.stubGlobal("navigator", { gpu: {} })
    const raw = '{"decisions":{"Annual revenue":"no match"}}'
    const createCompletion = vi.fn().mockResolvedValue({ choices: [{ message: { content: raw } }] })
    const engine = {
      chat: { completions: { create: createCompletion } },
      reload: vi.fn().mockResolvedValue(undefined),
      unload: vi.fn().mockResolvedValue(undefined),
    }
    webLlm.createEngine.mockResolvedValue(engine)

    const result = await new LocalModelProvider("personal-gemma2-2b-it-v1").completeJson<{ decisions: Array<{ target: string; source: string | null }> }>({
      task: "field_match",
      system: "Match fields.",
      input: "fields",
      schema: singleFieldSchema,
    })

    expect(createCompletion).toHaveBeenCalledTimes(1)
    expect(result.output.decisions).toEqual([
      { target: "Annual revenue | section: Merchant details", source: null },
    ])
  })

  it("fills omitted targets with null without inventing a source", async () => {
    vi.stubGlobal("navigator", { gpu: {} })
    const raw = '{"decisions":[{"target":"Operations email | section: Seller details","source":"Contact email"}]}'
    const createCompletion = vi.fn().mockResolvedValue({ choices: [{ message: { content: raw } }] })
    const engine = {
      chat: { completions: { create: createCompletion } },
      reload: vi.fn().mockResolvedValue(undefined),
      unload: vi.fn().mockResolvedValue(undefined),
    }
    webLlm.createEngine.mockResolvedValue(engine)

    const result = await new LocalModelProvider("personal-qwen25-15b-v1").completeJson<{ decisions: Array<{ target: string; source: string | null }> }>({
      task: "field_match",
      system: "Match fields.",
      input: "fields",
      schema: {
        type: "object",
        properties: {
          decisions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                target: { enum: ["Registered business | section: Seller details", "Operations email | section: Seller details"] },
                source: { enum: ["Legal company name", "Contact email", null] },
              },
            },
          },
        },
      },
    })

    expect(createCompletion).toHaveBeenCalledTimes(1)
    expect(result.output.decisions).toEqual([
      { target: "Registered business | section: Seller details", source: null },
      { target: "Operations email | section: Seller details", source: "Contact email" },
    ])
  })

  it("retries unsafe unknown identities instead of canonicalizing them", async () => {
    vi.stubGlobal("navigator", { gpu: {} })
    const unsafe = '{"target":"Annual revenue | section: Merchant details","source":"Invented source"}'
    const valid = '{"decisions":[{"target":"Annual revenue | section: Merchant details","source":"Annual turnover"}]}'
    const createCompletion = vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { content: unsafe } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: valid } }] })
    const engine = {
      chat: { completions: { create: createCompletion } },
      reload: vi.fn().mockResolvedValue(undefined),
      unload: vi.fn().mockResolvedValue(undefined),
    }
    webLlm.createEngine.mockResolvedValue(engine)

    const result = await new LocalModelProvider("personal-qwen25-15b-v1").completeJson<{ decisions: Array<{ target: string; source: string | null }> }>({
      task: "field_match",
      system: "Match fields.",
      input: "fields",
      schema: singleFieldSchema,
    })

    expect(createCompletion).toHaveBeenCalledTimes(2)
    expect(result.rawResponses).toEqual([unsafe, valid])
    expect(result.output.decisions[0].source).toBe("Annual turnover")
    expect(createCompletion.mock.calls[1][0].messages).not.toContainEqual({ role: "assistant", content: unsafe })
  })

  it("accepts a valid null field-match decision without retrying", async () => {
    vi.stubGlobal("navigator", { gpu: {} })
    const createCompletion = vi.fn().mockResolvedValue({
      choices: [{ message: { content: '{"decisions":[{"target":"Annual revenue | section: Merchant details","source":null}]}' } }],
    })
    const engine = {
      chat: { completions: { create: createCompletion } },
      reload: vi.fn().mockResolvedValue(undefined),
      unload: vi.fn().mockResolvedValue(undefined),
    }
    webLlm.createEngine.mockResolvedValue(engine)

    const result = await new LocalModelProvider("personal-qwen25-15b-v1").completeJson<{ decisions: Array<{ target: string; source: string | null }> }>({
      task: "field_match",
      system: "Match fields.",
      input: "fields",
      schema: singleFieldSchema,
    })

    expect(createCompletion).toHaveBeenCalledTimes(1)
    expect(result.output.decisions[0].source).toBeNull()
  })

  it("reloads and retries once when WebLLM loses its loaded model", async () => {
    vi.stubGlobal("navigator", { gpu: {} })
    const createCompletion = vi.fn()
      .mockRejectedValueOnce(new Error("Model not loaded before trying to complete ChatCompletionRequest."))
      .mockResolvedValueOnce({ choices: [{ message: { content: '{\"ok\":true}' } }] })
    const engine = {
      chat: { completions: { create: createCompletion } },
      reload: vi.fn().mockResolvedValue(undefined),
      unload: vi.fn().mockResolvedValue(undefined),
    }
    webLlm.createEngine.mockResolvedValue(engine)

    const result = await new LocalModelProvider("personal-qwen25-15b-v1").completeJson<{ ok: boolean }>({
      task: "field_match",
      system: "Return JSON.",
      input: {},
    })

    expect(engine.reload).toHaveBeenCalledWith(
      "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
      { context_window_size: 4096 },
    )
    expect(createCompletion).toHaveBeenCalledTimes(2)
    expect(result.output).toEqual({ ok: true })
  })

  it.each([
    "Device was lost during execution",
    "Cannot pass deleted object as a pointer of type GrammarMatcher",
    "Object has already been disposed",
  ])("discards the WebLLM engine after a fatal GPU error: %s", async (message) => {
    vi.stubGlobal("navigator", { gpu: {} })
    const failedCompletion = vi.fn().mockRejectedValue(new Error(message))
    const failedEngine = {
      chat: { completions: { create: failedCompletion } },
      reload: vi.fn().mockResolvedValue(undefined),
      unload: vi.fn().mockResolvedValue(undefined),
    }
    const recoveredEngine = {
      chat: { completions: { create: vi.fn().mockResolvedValue({ choices: [{ message: { content: '{\"ok\":true}' } }] }) } },
      reload: vi.fn().mockResolvedValue(undefined),
      unload: vi.fn().mockResolvedValue(undefined),
    }
    webLlm.createEngine.mockResolvedValueOnce(failedEngine).mockResolvedValueOnce(recoveredEngine)
    const provider = new LocalModelProvider("personal-qwen25-15b-v1")
    const request = { task: "field_match" as const, system: "Return JSON.", input: {} }

    await expect(provider.completeJson(request)).rejects.toThrow(
      `Local AI GPU session was lost. The model will be reloaded on the next attempt. Original error: ${message}`,
    )
    const result = await provider.completeJson<{ ok: boolean }>(request)

    expect(webLlm.createEngine).toHaveBeenCalledTimes(2)
    expect(result.output).toEqual({ ok: true })
  })

})
