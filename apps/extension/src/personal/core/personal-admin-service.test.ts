import "fake-indexeddb/auto"

import { describe, expect, it, vi } from "vitest"

import { PersonalAdminService } from "./personal-admin-service"
import type { ModelResult } from "../ai/model-provider"
import { deleteStored, putStored } from "../storage/indexed-db"

describe("Personal administration", () => {
  it("exports diagnostics without Personal information or credentials", async () => {
    const previousChrome = globalThis.chrome
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        storage: { local: { get: async () => ({}) } },
        runtime: { getManifest: () => ({ name: "RekeyZero Personal", version: "0.1.0" }) },
      },
    })
    try {
      const diagnostics = JSON.parse(await new PersonalAdminService().exportDiagnostics())
      expect(diagnostics.extension).toEqual({
        name: "RekeyZero Personal",
        version: "0.1.0",
        profile: "personal",
      })
      expect(JSON.stringify(diagnostics)).not.toContain("apiKey")
      expect(diagnostics.exclusions).toContain("source field values")
      expect(diagnostics.exclusions).toContain("Mapping Profile content")
    } finally {
      Object.defineProperty(globalThis, "chrome", { configurable: true, value: previousChrome })
    }
  })

  it("exports only current Workspace stores and includes Mapping Profiles", async () => {
    const profile = {
      id: `profile-${crypto.randomUUID()}`,
      name: "Exported profile",
      version: 1,
      source: { origin: "https://source.example.test", pathPattern: "/:segment", template: "source", title: "Source" },
      targets: [],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    }
    await putStored("transfer_mapping_profiles", profile)
    try {
      const exported = JSON.parse(await new PersonalAdminService().exportData())
      expect(exported.transfer_mapping_profiles).toContainEqual(profile)
      for (const store of ["records", "revisions", "evidence", "provider_configs"]) expect(exported).not.toHaveProperty(store)
      expect(exported).not.toHaveProperty("destinations")
      expect(exported).not.toHaveProperty("mappings")
      expect(exported).not.toHaveProperty("browser_tasks")
      expect(exported).not.toHaveProperty("actions")
      expect(exported).not.toHaveProperty("executions")
    } finally {
      await deleteStored("transfer_mapping_profiles", profile.id)
    }
  })

  it("lists Mapping Profiles directly in Admin", async () => {
    const profile = {
      id: `profile-${crypto.randomUUID()}`,
      name: "Seller profile",
      version: 1,
      source: { origin: "https://source.example.test", pathPattern: "/:segment", template: "source", title: "Source" },
      targets: [{
        id: "target",
        origin: "https://seller.example.test",
        pathPattern: "/:segment",
        template: "seller",
        title: "Seller",
        mappings: [
          { sourceTemplateKey: "company", targetTemplateKey: "merchant", existingValuePolicy: "blank_only" as const },
          { sourceTemplateKey: "email", targetTemplateKey: "email", existingValuePolicy: "blank_only" as const },
        ],
      }],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-02-01T00:00:00Z",
    }
    await putStored("transfer_mapping_profiles", profile)
    try {
      const home = await new PersonalAdminService().home()
      expect(home.profiles).toContainEqual(profile)
    } finally {
      await deleteStored("transfer_mapping_profiles", profile.id)
    }
  })

  it("saves and deletes an Admin-edited Profile and publishes a refresh revision", async () => {
    const previousChrome = globalThis.chrome
    const publish = vi.fn(async () => undefined)
    const removePermission = vi.fn(async () => true)
    Object.defineProperty(globalThis, "chrome", { configurable: true, value: {
      storage: { local: { set: publish, get: async () => ({}) } },
      permissions: { remove: removePermission },
    } })
    const profile = {
      id: `profile-${crypto.randomUUID()}`,
      name: "Original name",
      version: 1 as const,
      source: { origin: "https://source.example.test", pathPattern: "/:segment", template: "source", title: "Source" },
      targets: [{ id: "target", origin: "https://target.example.test", pathPattern: "/:segment", template: "target", title: "Target", mappings: [
        { sourceTemplateKey: "company", targetTemplateKey: "merchant", existingValuePolicy: "blank_only" as const },
      ] }],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    }
    await putStored("transfer_mapping_profiles", profile)
    try {
      const service = new PersonalAdminService()
      const saved = await service.saveProfile({ ...profile, name: "  Updated name  ", targets: [{
        ...profile.targets[0], mappings: [{ ...profile.targets[0].mappings[0], existingValuePolicy: "overwrite" }],
      }] })
      expect(saved.profiles[0]).toMatchObject({ name: "Updated name", targets: [{ mappings: [{ existingValuePolicy: "overwrite" }] }] })
      expect(publish).toHaveBeenCalledOnce()

      const remaining = await service.deleteProfile(profile.id)
      expect(remaining.profiles).toEqual([])
      expect(removePermission).toHaveBeenCalledTimes(2)
      expect(publish).toHaveBeenCalledTimes(2)
    } finally {
      await deleteStored("transfer_mapping_profiles", profile.id)
      Object.defineProperty(globalThis, "chrome", { configurable: true, value: previousChrome })
    }
  })

  it("requires the downloaded and enabled browser-local model for AI Fill", async () => {
    await deleteStored("settings", "personal")
    try {
      await expect(new PersonalAdminService().matchLocalFields({ controls: [{
        control_id: "target", tag: "input", type: "text", role: "", name: "", label: "Different",
        placeholder: "", required: false, disabled: false, current_value: "", checked: null, options: [],
      }], candidates: [{ information_path: "source", label_text: "Source", type: "text" }] }))
        .rejects.toThrow("Enable Local AI in the Side Panel")
    } finally {
      await deleteStored("settings", "personal")
    }
  })

  it("stores one selected Local AI model and exposes all model sizes", async () => {
    await deleteStored("settings", "personal")
    const load = vi.fn().mockResolvedValue(undefined)
    const providerFactory = vi.fn((modelId: string) => ({
      id: modelId,
      kind: "browser_local" as const,
      health: async () => ({ status: "ready" as const }),
      completeJson: async <T,>(): Promise<ModelResult<T>> => { throw new Error("Not used") },
      load,
      delete: vi.fn().mockResolvedValue(undefined),
    }))
    try {
      const service = new PersonalAdminService(undefined, providerFactory)
      const enabled = await service.setLocalAiEnabled(true, "personal-qwen25-15b-v1")

      expect(load).toHaveBeenCalledTimes(1)
      expect(enabled).toMatchObject({
        localModelEnabled: true,
        localModelId: "personal-qwen25-15b-v1",
      })
      expect(enabled.localModels).toEqual([
        { modelArtifact: "gemma-2-2b-it-q4f16_1-MLC", estimatedDownloadBytes: 1_490_000_000 },
        { modelArtifact: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC", estimatedDownloadBytes: 880_000_000 },
      ].map((expected) => expect.objectContaining(expected)))

      const disabled = await service.setLocalAiEnabled(false, "personal-qwen25-15b-v1")
      expect(disabled).toMatchObject({ localModelEnabled: false, localModelId: "personal-qwen25-15b-v1" })
    } finally {
      await deleteStored("settings", "personal")
    }
  })

  it("resolves exact fields without loading AI and never logs source values in the request", async () => {
    await deleteStored("settings", "personal")
    const service = new PersonalAdminService()
    const matches = await service.matchLocalFields({
      target: "Target page",
      controls: [{
        control_id: "target", tag: "input", type: "text", role: "", name: "", label: "Company Name",
        placeholder: "", required: false, disabled: false, current_value: "", checked: null, options: [],
      }],
      candidates: [{
        information_path: "source", label_text: " company-name ", type: "text", value: "private customer value",
      }],
    })
    expect(matches).toEqual([{ control_id: "target", information_path: "source" }])
    const log = (await service.llmLogs()).at(-1)!
    expect(log).toMatchObject({ target: "Target page", providerId: "deterministic", ai_request: null })
    expect(JSON.stringify(log)).not.toContain("private customer value")
    await deleteStored("llm_logs", log.id)
  })
})
