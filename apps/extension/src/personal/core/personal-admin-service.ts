import { LocalModelProvider } from "../ai/local-model-provider"
import { DEFAULT_LOCAL_MODEL_ID, LOCAL_MODELS, localModel } from "../ai/model-registry"
import { PersonalModelRouter } from "../ai/model-router"
import type { LocalFieldMatchOutput } from "../ai/field-match-prompt"
import type { PersonalModelProvider } from "../ai/model-provider"
import { exactFieldMatches, validateFieldMatches } from "../ai/semantic-matcher"
import type { SourceFieldCandidate, StableFieldMatch } from "../ai/semantic-matcher"
import { hostPermissionPattern, removeHostPermissionIfUnused } from "../permissions/host-permissions"
import {
  clearPersonalDatabase,
  deleteStored,
  exportPersonalDatabaseRecovery,
  getAllStored,
  getStored,
  putStored,
} from "../storage/indexed-db"
import type { PersonalLlmLog, PersonalLlmLogMatch, PersonalSettings } from "../storage/schema"
import type { PageControl, PersonalAiSettingsView, PersonalHomeData } from "../../shared/types"
import type { MappingProfile } from "../../transfer/types"
import { notifyProfilesChanged } from "../../transfer/store"
import { configuredBuiltinApiOrigins } from "../ai/direct-api-provider"
import type { PersonalAdminApi } from "./personal-admin-api"

const DEFAULT_SETTINGS: PersonalSettings = {
  id: "personal",
  localModelId: DEFAULT_LOCAL_MODEL_ID,
  localModelEnabled: false,
}

type ManagedLocalProvider = PersonalModelProvider & {
  load(): Promise<void>
  delete(): Promise<void>
}

export class PersonalAdminService implements PersonalAdminApi {
  constructor(
    private readonly modelRouter = new PersonalModelRouter(),
    private readonly localProvider: (modelId: string) => ManagedLocalProvider =
      (modelId) => new LocalModelProvider(modelId),
  ) {}

  async settings(): Promise<PersonalSettings> {
    const existing = await getStored<PersonalSettings>("settings", "personal")
    return existing ?? putStored("settings", DEFAULT_SETTINGS)
  }

  async home(): Promise<PersonalHomeData> {
    const profiles = await getAllStored<MappingProfile>("transfer_mapping_profiles")
    return { profiles: profiles.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)) }
  }

  async saveProfile(candidate: MappingProfile): Promise<PersonalHomeData> {
    const existing = await getStored<MappingProfile>("transfer_mapping_profiles", candidate.id)
    if (!existing) throw new Error("Mapping Profile is unavailable")
    const name = candidate.name.trim()
    if (!name) throw new Error("Enter a Mapping Profile name")
    if (candidate.targets.length !== existing.targets.length) {
      throw new Error("Use the Side Panel to add or remove target pages")
    }
    const targets = existing.targets.map((target) => {
      const edited = candidate.targets.find((item) => item.id === target.id)
      if (!edited || edited.mappings.length !== target.mappings.length) {
        throw new Error("Use the Side Panel to change the target page structure")
      }
      const mappings = edited.mappings.map((mapping) => {
        const sourceTemplateKey = mapping.sourceTemplateKey.trim()
        const targetTemplateKey = mapping.targetTemplateKey.trim()
        if (!targetTemplateKey) throw new Error("Every mapping needs a target field key")
        if (mapping.existingValuePolicy !== "skip" && !sourceTemplateKey) {
          throw new Error("Every active mapping needs a source field key")
        }
        if (!["blank_only", "overwrite", "skip"].includes(mapping.existingValuePolicy)) {
          throw new Error("Choose a valid existing-value policy")
        }
        return { sourceTemplateKey, targetTemplateKey, existingValuePolicy: mapping.existingValuePolicy }
      })
      const targetKeys = mappings.map((mapping) => mapping.targetTemplateKey)
      if (new Set(targetKeys).size !== targetKeys.length) {
        throw new Error(`Target field keys must be unique for ${target.title}`)
      }
      return { ...target, mappings }
    })
    const saved: MappingProfile = {
      ...existing,
      name,
      targets,
      updatedAt: new Date().toISOString(),
    }
    await putStored("transfer_mapping_profiles", saved)
    await notifyProfilesChanged()
    return this.home()
  }

  async deleteProfile(profileId: string): Promise<PersonalHomeData> {
    const deleted = await getStored<MappingProfile>("transfer_mapping_profiles", profileId)
    if (!deleted) throw new Error("Mapping Profile is unavailable")
    await deleteStored("transfer_mapping_profiles", profileId)
    const remaining = await getAllStored<MappingProfile>("transfer_mapping_profiles")
    const providerOrigins = await configuredBuiltinApiOrigins()
    const origins = [...new Set([deleted.source.origin, ...deleted.targets.map((target) => target.origin)])]
    await Promise.all(origins.map((origin) => removeHostPermissionIfUnused({
      origin,
      providerOrigins,
      profiles: remaining,
    }).catch(() => false)))
    await notifyProfilesChanged()
    return this.home()
  }

  async clearAll(): Promise<void> {
    const profiles = await getAllStored<MappingProfile>("transfer_mapping_profiles")
    const origins = Array.from(new Set([
      ...profiles.flatMap((profile) => [
        hostPermissionPattern(profile.source.origin),
        ...profile.targets.map((target) => hostPermissionPattern(target.origin)),
      ]),
    ]))
    if (origins.length) await chrome.permissions.remove({ origins }).catch(() => false)
    await clearPersonalDatabase()
  }

  async exportData(): Promise<string> {
    const stores = [
      "settings",
      "transfer_mapping_profiles", "llm_logs",
    ] as const
    const exported = Object.fromEntries(
      await Promise.all(stores.map(async (store) => [store, await getAllStored(store)])),
    )
    return JSON.stringify(exported, null, 2)
  }

  async exportRecoveryData(): Promise<string> {
    return JSON.stringify({
      recovery_schema_version: 2,
      generated_at: new Date().toISOString(),
      stores: await exportPersonalDatabaseRecovery(),
    }, null, 2)
  }

  async exportDiagnostics(): Promise<string> {
    const [settings, ai] = await Promise.all([
      this.settings(),
      this.aiSettings(),
    ])
    const manifest = chrome.runtime.getManifest()
    return JSON.stringify({
      diagnostic_schema_version: 2,
      generated_at: new Date().toISOString(),
      extension: { name: manifest.name, version: manifest.version, profile: "personal" },
      environment: {
        browser_user_agent: navigator.userAgent.replace(/\([^)]*\)/, "(platform redacted)"),
        webgpu_available: "gpu" in navigator,
      },
      capabilities: {
        local_ai_enabled: settings.localModelEnabled,
        local_ai_status: ai.localModelStatus,
        external_provider_configured: (await configuredBuiltinApiOrigins()).length > 0,
      },
      exclusions: [
        "API keys",
        "source field values",
        "Mapping Profile content",
        "page text",
        "provider response bodies",
      ],
    }, null, 2)
  }

  async aiSettings(): Promise<PersonalAiSettingsView> {
    const settings = await this.settings()
    const localModels = await Promise.all(LOCAL_MODELS.map(async (model) => {
      const health = await this.localProvider(model.id).health()
      return {
        id: model.id,
        displayName: model.displayName,
        modelArtifact: model.modelArtifact,
        runtimeAvailable: model.runtimeAvailable,
        experimental: Boolean(model.experimental),
        unavailableReason: model.unavailableReason,
        status: health.status,
        detail: health.detail,
        estimatedDownloadBytes: model.estimatedDownloadBytes,
        estimatedPeakMemoryMb: model.estimatedPeakMemoryMb,
      }
    }))
    const local = localModels.find((model) => model.id === settings.localModelId)
      ?? { status: "not_ready" as const, detail: "No Local AI model selected" }
    return {
      localModelEnabled: settings.localModelEnabled,
      localModelId: settings.localModelId,
      localModelStatus: local.status,
      localModelDetail: local.detail,
      localModels,
    }
  }

  async llmLogs(): Promise<PersonalLlmLog[]> {
    const logs = await getAllStored<PersonalLlmLog>("llm_logs")
    return logs.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  async matchLocalFields(input: {
    target?: string
    controls: PageControl[]
    allTargetControls?: PageControl[]
    candidates: SourceFieldCandidate[]
  }): Promise<Array<{ control_id: string; information_path: string }>> {
    const exactMatches = exactFieldMatches(
      input.controls,
      input.candidates,
      input.allTargetControls ?? input.controls,
    )
    const exactTargets = new Set(exactMatches.map((match) => match.control_id))
    const exactSources = new Set(exactMatches.map((match) => match.information_path))
    const unresolvedControls = input.controls.filter((control) => !exactTargets.has(control.control_id))
    const remainingCandidates = input.candidates.filter((candidate) => !exactSources.has(candidate.information_path))
    const router = this.modelRouter
    let result: Awaited<ReturnType<PersonalModelRouter["matchFields"]>> | null = null
    let acceptedAiMatches: StableFieldMatch[] = []
    let rejectedMappings: unknown[] = []

    if (unresolvedControls.length && remainingCandidates.length) {
      const ai = await this.aiSettings()
      if (!ai.localModelEnabled || ai.localModelStatus !== "ready") {
        throw new Error("Enable Local AI in the Side Panel before creating an AI Fill Setup")
      }
      const contextChars = JSON.stringify({
        controls: unresolvedControls,
        candidates: remainingCandidates.map(({ value: _value, ...candidate }) => candidate),
      }).length
      const decision = await router.decision({
        destinationFieldCount: unresolvedControls.length,
        unresolvedFieldCount: unresolvedControls.length,
        contextChars,
      })
      if (decision.route !== "local_lite") {
        throw new Error("This Fill Setup cannot run with browser-local AI. Reduce the selected pages or confirm the Local AI model is downloaded and enabled.")
      }
      result = await router.matchFields({
        route: "local_lite",
        controls: unresolvedControls,
        candidates: remainingCandidates,
        decision,
      })
      const validation = validateFieldMatches(result.matches, unresolvedControls, remainingCandidates)
      acceptedAiMatches = validation.accepted
      rejectedMappings = [...result.invalidMappings, ...validation.rejected]
    }

    const matches = [...exactMatches, ...acceptedAiMatches]
    const describeMatch = (match: StableFieldMatch): PersonalLlmLogMatch => ({
      ...match,
      target_label: input.controls.find((control) => control.control_id === match.control_id)?.label_text
        ?? input.controls.find((control) => control.control_id === match.control_id)?.label
        ?? "Unknown target field",
      source_label: input.candidates.find((candidate) => candidate.information_path === match.information_path)?.label_text
        ?? match.information_path,
    })
    await putStored<PersonalLlmLog>("llm_logs", {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      task: "field_match",
      target: input.target ?? "Unknown target page",
      providerId: result?.providerId ?? "deterministic",
      modelId: result?.modelId ?? "none",
      exact_matches: exactMatches.map(describeMatch),
      ai_request: result?.request ?? null,
      raw_response: result?.rawResponses.join("\n") ?? "",
      parsed_mappings: result
        ? (result.response as LocalFieldMatchOutput).decisions
        : [],
      rejected_mappings: rejectedMappings,
      final_mappings: matches.map(describeMatch),
    })
    return matches
  }

  async setLocalAiEnabled(enabled: boolean, modelId: string): Promise<PersonalAiSettingsView> {
    const settings = await this.settings()
    localModel(modelId)
    if (enabled) {
      const provider = this.localProvider(modelId)
      await provider.load()
      settings.localModelId = modelId
    }
    settings.localModelEnabled = enabled
    await putStored("settings", settings)
    return this.aiSettings()
  }

}
