import "fake-indexeddb/auto"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { PageControl } from "../../shared/types"
import { PersonalAdminService } from "../core/personal-admin-service"
import { deleteStored, getAllStored, putStored } from "../storage/indexed-db"
import { resetTransferRuntime, transferCommand } from "../../transfer/controller"
import { saveSession } from "../../transfer/store"
import type { Field, MappingProfile, Observation, Session, Snapshot } from "../../transfer/types"
import type { ModelRequest, ModelResult, PersonalModelProvider } from "./model-provider"
import { PersonalModelRouter } from "./model-router"

type LocalSchema = {
  properties: {
    decisions: {
      minItems: number
      maxItems: number
      items: {
        properties: {
          source: { enum: Array<string | null> }
          target: { enum: string[] }
        }
      }
    }
  }
}

const field = (instanceKey: string, templateKey: string, label: string, type: string, value: string | boolean): Field => ({
  id: instanceKey,
  instanceKey,
  templateKey,
  templateStable: true,
  instanceStable: true,
  ambiguousInObservation: false,
  label,
  group: "",
  type,
  value,
  display: String(value),
  options: [],
  required: false,
  writable: true,
  reusable: true,
})

const control = (source: Field): PageControl => ({
  control_id: source.instanceKey,
  tag: "input",
  type: source.type,
  role: "",
  name: "",
  label: source.label,
  label_text: source.label,
  group_text: source.group,
  placeholder: "",
  required: source.required,
  disabled: !source.writable,
  current_value: source.value,
  checked: typeof source.value === "boolean" ? source.value : null,
  options: source.options,
})

describe("Local AI Fill Setup orchestration", () => {
  const previousChrome = globalThis.chrome
  const previousNavigator = globalThis.navigator
  const sessionValues: Record<string, unknown> = {}
  const sourceFields = [
    field("source-order", "source-order-template", "Order number", "text", "ORD-123"),
    field("source-wrong", "source-wrong-template", "Unrelated name", "text", "Wrong"),
    field("source-account", "source-account-template", "Account name", "text", "Acme"),
    field("source-email", "source-email-template", "Notification email", "email", "team@example.test"),
    field("source-boolean", "source-boolean-template", "Terms accepted", "checkbox", true),
  ]
  const targetFields = [
    field("target-order", "target-order-template", "Order number", "text", ""),
    field("target-account", "target-account-template", "Customer account", "text", ""),
    field("target-email", "target-email-template", "Email address", "email", ""),
    field("target-enabled", "target-enabled-template", "Enabled", "checkbox", false),
  ]

  beforeEach(async () => {
    Object.keys(sessionValues).forEach((key) => delete sessionValues[key])
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { gpu: {} } })
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        storage: {
          session: {
            setAccessLevel: async () => undefined,
            get: async (key: string) => ({ [key]: sessionValues[key] }),
            set: async (values: Record<string, unknown>) => Object.assign(sessionValues, values),
            remove: async (key: string) => { delete sessionValues[key] },
          },
          local: { set: async () => undefined },
        },
        tabs: {
          get: async (tabId: number) => ({
            id: tabId,
            windowId: 1,
            status: "complete",
            title: tabId === 1 ? "Source" : "Target",
            url: tabId === 1 ? "https://source.example.test/customer/1" : "https://target.example.test/form/1",
          }),
        },
      },
    })
    await resetTransferRuntime()
    await putStored("settings", {
      id: "personal",
      localModelId: "personal-qwen35-08b-v1",
      localModelEnabled: true,
    })
  })

  afterEach(async () => {
    const logs = await new PersonalAdminService().llmLogs()
    await Promise.all(logs.map((log) => deleteStored("llm_logs", log.id)))
    const profiles = await getAllStored<MappingProfile>("transfer_mapping_profiles")
    await Promise.all(profiles.map((profile) => deleteStored("transfer_mapping_profiles", profile.id)))
    await deleteStored("settings", "personal")
    await resetTransferRuntime()
    Object.defineProperty(globalThis, "chrome", { configurable: true, value: previousChrome })
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNavigator })
  })

  it("removes exact-used sources and treats source null as an explicit abstention", async () => {
    const provider: PersonalModelProvider & { load(): Promise<void>; delete(): Promise<void> } = {
      id: "mock-local",
      kind: "browser_local",
      health: async () => ({ status: "ready" }),
      load: async () => undefined,
      delete: async () => undefined,
      completeJson: async <T,>(request: ModelRequest): Promise<ModelResult<T>> => {
        expect(typeof request.input).toBe("string")
        const input = request.input as string
        expect(input).toContain("Source fields still available:")
        expect(input).not.toContain("Order number")
        expect(input).toContain("Account name [type: text]")
        expect(input).toContain("Customer account [type: text]")
        const schema = request.schema as LocalSchema
        expect(schema.properties.decisions.minItems).toBe(3)
        expect(schema.properties.decisions.maxItems).toBe(3)
        expect(schema.properties.decisions.items.properties.source.enum).not.toContain("Order number")
        expect(schema.properties.decisions.items.properties.source.enum).toContain(null)
        expect(schema.properties.decisions.items.properties.target.enum).not.toContain("Order number")
        const output = { decisions: [
          { source: "Account name", target: "Customer account" },
          { source: "Notification email", target: "Email address" },
          { source: null, target: "Enabled" },
        ] }
        return { output: output as T, providerId: "mock-local", modelId: "test-local-model", rawResponses: [JSON.stringify(output)] }
      },
    }
    const providerFactory = () => provider
    const service = new PersonalAdminService(new PersonalModelRouter(providerFactory), providerFactory)
    const candidates = sourceFields.map((item) => ({
      information_path: item.instanceKey,
      label_text: item.label,
      group_text: item.group,
      type: item.type,
      value: item.value,
    }))
    const matches = await service.matchLocalFields({
      target: "Target",
      controls: targetFields.map(control),
      candidates,
    })

    expect(matches).toEqual([
      { control_id: "target-order", information_path: "source-order" },
      { control_id: "target-account", information_path: "source-account" },
      { control_id: "target-email", information_path: "source-email" },
    ])
    const log = (await service.llmLogs()).at(-1)!
    expect(log.parsed_mappings).toEqual([
      { source: "Account name", target: "Customer account" },
      { source: "Notification email", target: "Email address" },
      { source: null, target: "Enabled" },
    ])
    expect(log.rejected_mappings).toEqual([])

    const source: Snapshot = {
      epoch: "source-epoch", identity: "source-record", pageIdentity: "source-record",
      identityEvidence: [], identityConfidence: "high", template: "source-template",
      structure: "source-structure", origin: "https://source.example.test", title: "Source",
      fields: sourceFields, scannedCount: sourceFields.length, eligibleCount: sourceFields.length,
      truncated: false, id: "source-snapshot", hash: "source-hash", capturedAt: "2026-09-08T00:00:00Z",
      group: "", availableGroups: [],
    }
    const observation: Observation = {
      epoch: "target-epoch", identity: "target-record", pageIdentity: "target-record",
      identityEvidence: [], identityConfidence: "new_form", template: "target-template",
      structure: "target-structure", origin: "https://target.example.test", title: "Target",
      fields: targetFields, scannedCount: targetFields.length, eligibleCount: targetFields.length,
      truncated: false,
    }
    const initial: Session = {
      id: "session", revision: 0, status: "needs_input", sourceTabId: 1, source,
      frozen: false, targets: [{
        id: "target", tabId: 2, windowId: 1, origin: observation.origin, title: observation.title,
        status: "needs_input", observation, decisions: {},
      }],
    }
    await saveSession(initial)
    const applied = await transferCommand({
      type: "APPLY_AI_FIELD_MATCHES",
      targets: [{ targetId: "target", mappings: matches.map((match) => ({
        targetInstanceKey: match.control_id,
        sourceInstanceKey: match.information_path,
      })) }],
    }) as Session
    const actions = applied.targets[0].plan!.actions
    expect(actions.find((action) => action.field.instanceKey === "target-account")?.sourceInstanceKey).toBe("source-account")
    expect(actions.find((action) => action.field.instanceKey === "target-enabled")?.sourceInstanceKey).toBeUndefined()
    expect(actions.find((action) => action.field.instanceKey === "target-order")?.sourceInstanceKey).toBe("source-order")
    expect(actions.find((action) => action.field.instanceKey === "target-email")?.sourceInstanceKey).toBe("source-email")

    const saved = await transferCommand({
      type: "SAVE_MAPPING_PROFILE",
      kind: "ai_fill_setup",
      name: "Validated setup",
      targets: [{ targetId: "target", mappings: actions.map((action) => ({
        targetInstanceKey: action.field.instanceKey,
        sourceInstanceKey: action.sourceInstanceKey,
        existingValuePolicy: action.sourceInstanceKey ? "blank_only" : "skip",
      })) }],
    }) as MappingProfile
    expect(saved.targets[0].mappings).toEqual([
      { sourceTemplateKey: "source-order-template", targetTemplateKey: "target-order-template", existingValuePolicy: "blank_only" },
      { sourceTemplateKey: "source-account-template", targetTemplateKey: "target-account-template", existingValuePolicy: "blank_only" },
      { sourceTemplateKey: "source-email-template", targetTemplateKey: "target-email-template", existingValuePolicy: "blank_only" },
      { sourceTemplateKey: "", targetTemplateKey: "target-enabled-template", existingValuePolicy: "skip" },
    ])
    await deleteStored("transfer_mapping_profiles", saved.id)
  })

  it("rejects a visible identity that resolves to multiple source fields", async () => {
    const output = { decisions: [{
      source: "Annual turnover | section: Financials",
      target: "Annual revenue | section: Merchant details",
    }] }
    const provider: PersonalModelProvider & { load(): Promise<void>; delete(): Promise<void> } = {
      id: "mock-local",
      kind: "browser_local",
      health: async () => ({ status: "ready" }),
      load: async () => undefined,
      delete: async () => undefined,
      completeJson: async <T,>(): Promise<ModelResult<T>> => ({
        output: output as T,
        providerId: "mock-local",
        modelId: "test-local-model",
        rawResponses: [JSON.stringify(output)],
      }),
    }
    const providerFactory = () => provider
    const service = new PersonalAdminService(new PersonalModelRouter(providerFactory), providerFactory)

    const matches = await service.matchLocalFields({
      controls: [{
        ...control(field("target-revenue", "target-revenue-template", "Annual revenue", "number", "")),
        group_text: "Merchant details",
      }],
      candidates: ["turnover-primary", "turnover-secondary"].map((information_path) => ({
        information_path,
        label_text: "Annual turnover",
        group_text: "Financials",
        type: "number",
        value: "2750000",
      })),
    })

    expect(matches).toEqual([])
    const log = (await service.llmLogs()).at(-1)!
    expect(log.rejected_mappings).toEqual([{ ...output.decisions[0], reason: "ambiguous_identity" }])
  })
})
