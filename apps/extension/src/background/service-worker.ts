import { PersonalAdminService } from "../personal/core/personal-admin-service"

import { matchFieldsWithBuiltinApi } from "../personal/ai/builtin-api-field-matcher"
import {
  BUILTIN_API_MODELS,
  DirectApiProvider,
  builtinApiModel,
  builtinApiHealth,
  builtinApiModelConfig,
  clearBuiltinApiModels,
  configureBuiltinApiModel,
  removeBuiltinApiModel,
} from "../personal/ai/direct-api-provider"
import type { WorkerRequest, WorkerResponse } from "../shared/messages"
import type { PersonalAiSettingsView } from "../shared/types"
import { logPersonalRuntimeError } from "../personal/storage/runtime-error-log"
import { invalidateTransferTab, resetTransferRuntime, transferCommand, transferTabReady } from "../transfer/controller"
import type { Command as TransferCommand, Session } from "../transfer/types"
import { localModel } from "../personal/ai/model-registry"
import { clearSourcePrepare, getSourcePrepare, prepareSource, safePrepareError, showSourcePrepareEvidence, undoSourcePrepare } from "../personal/source-prepare/source-prepare-service"
import { sourceDocumentsForExtraction } from "../personal/source-prepare/source-prepare-store"

const API_MODEL_STORAGE_KEY = "rekeyzeroPersonalApiModelId"
const LEGACY_API_MODEL_IDS: Record<string, string> = {
  "personal-gemini-31-flash-lite-v1": "personal-gemini-api-v1",
  "personal-gemini-35-flash-v1": "personal-gemini-api-v1",
  "personal-gemini-38-flash-v1": "personal-gemini-api-v1",
  "personal-deepseek-v41-flash-v1": "personal-deepseek-api-v1",
  "personal-deepseek-v4-flash-v1": "personal-deepseek-api-v1",
}
const personalAdmin = new PersonalAdminService()

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "RekeyZero could not complete this browser action"
}

async function reportRuntimeError(error: unknown, requestType: string): Promise<void> {
  if (requestType.includes("PREPARE_SOURCE") || requestType === "PERSONAL_SHOW_PREPARE_EVIDENCE") return
  const apiModelId = await selectedApiModelId().catch(() => null)
  const apiModel = BUILTIN_API_MODELS.find((model) => model.id === apiModelId)
  const apiConfig = apiModel ? await builtinApiModelConfig(apiModel.id).catch(() => null) : null
  const localSettings = apiModel ? null : await personalAdmin.aiSettings().catch(() => null)
  const context = apiModel
    ? { providerId: apiModel.provider, modelId: apiConfig?.model ?? "not-configured" }
    : localSettings?.localModelEnabled && localSettings.localModelId
      ? { providerId: "personal-local-lite", modelId: localSettings.localModelId }
      : {}
  const rawResponses = error instanceof Error && "rawResponses" in error
    && Array.isArray((error as Error & { rawResponses?: unknown }).rawResponses)
    ? (error as Error & { rawResponses: string[] }).rawResponses
    : []
  await logPersonalRuntimeError(error, requestType, {
    ...context,
    ...(rawResponses.length ? { rawResponse: rawResponses.join("\n\n--- retry ---\n\n") } : {}),
  }).catch(() => undefined)
}

globalThis.addEventListener("error", (event: ErrorEvent) => {
  void reportRuntimeError(event.error ?? event.message, "UNHANDLED_ERROR")
})

globalThis.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
  void reportRuntimeError(event.reason, "UNHANDLED_REJECTION")
})

function isBuiltinApiModel(modelId: string): boolean {
  return BUILTIN_API_MODELS.some((model) => model.id === modelId)
}

async function selectedApiModelId(): Promise<string | null> {
  const stored = await chrome.storage.local.get(API_MODEL_STORAGE_KEY)
  const modelId = stored[API_MODEL_STORAGE_KEY]
  if (typeof modelId !== "string") return null
  const currentModelId = LEGACY_API_MODEL_IDS[modelId] ?? modelId
  if (!isBuiltinApiModel(currentModelId)) return null
  if (currentModelId !== modelId) await chrome.storage.local.set({ [API_MODEL_STORAGE_KEY]: currentModelId })
  return currentModelId
}

async function aiSettingsView(base?: PersonalAiSettingsView): Promise<PersonalAiSettingsView> {
  const current = base ?? await personalAdmin.aiSettings()
  const apiModelId = await selectedApiModelId()
  const configs = new Map(await Promise.all(BUILTIN_API_MODELS.map(async (model) => [model.id, await builtinApiModelConfig(model.id)] as const)))
  const health = new Map(await Promise.all(BUILTIN_API_MODELS.map(async (model) => [model.id, await builtinApiHealth(model.id)] as const)))
  const apiModels = BUILTIN_API_MODELS.map((model) => {
    const modelHealth = health.get(model.id) ?? {
      status: "not_ready" as const,
      model: model.defaultModel,
      detail: "Enter the API key in the extension UI.",
    }
    const config = configs.get(model.id)
    return {
      id: model.id,
      displayName: `${model.displayName} · API`,
      provider: model.provider,
      origin: model.origin,
      model: modelHealth.model ?? model.defaultModel,
      defaultModel: model.defaultModel,
      defaultReason: model.defaultReason,
      supportedTasks: [...model.supportedTasks],
      models: model.models.map((option) => ({ ...option, recommended: option.id === model.defaultModel })),
      status: modelHealth.status,
      detail: modelHealth.detail,
      configured: config?.configured ?? false,
      hasKey: config?.hasKey ?? false,
      rememberKey: config?.rememberKey ?? false,
    }
  })
  const apiCards = BUILTIN_API_MODELS.map((model) => {
    const modelHealth = health.get(model.id) ?? {
      status: "not_ready" as const,
      model: model.defaultModel,
      detail: "Enter the API key in the extension UI.",
    }
    return {
      id: model.id,
      displayName: `${model.displayName} · API`,
      modelArtifact: modelHealth.model ? `${modelHealth.model} · direct API` : "",
      runtimeAvailable: true,
      experimental: false,
      status: modelHealth.status,
      detail: modelHealth.detail,
      unavailableReason: modelHealth.status === "ready" ? undefined : "Not ready",
      estimatedDownloadBytes: 0,
      estimatedPeakMemoryMb: 0,
      supportedTasks: [...model.supportedTasks],
    }
  })
  const selectedApiHealth = apiModelId ? health.get(apiModelId) : undefined
  return {
    ...current,
    selectedModelId: apiModelId ?? (current.localModelEnabled ? current.localModelId : null),
    apiModelId,
    apiModels,
    localModelEnabled: apiModelId ? true : current.localModelEnabled,
    localModelId: apiModelId ?? current.localModelId,
    localModelStatus: apiModelId ? selectedApiHealth?.status ?? "not_ready" : current.localModelStatus,
    localModelDetail: apiModelId ? selectedApiHealth?.detail : current.localModelDetail,
    localModels: [...current.localModels.map((model) => ({ ...model, supportedTasks: localModel(model.id).supportedTasks })), ...apiCards],
  }
}

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined)

async function handleWorkspaceRequest(request: WorkerRequest): Promise<unknown> {
  if (request.type === "PERSONAL_EXPORT_PROFILE") return personalAdmin.exportProfile(request.profileId)
  if (request.type === "PERSONAL_IMPORT_PROFILE") return personalAdmin.importProfile(request.content)
  if (request.type === "PERSONAL_GET_HOME") return personalAdmin.home()
  if (request.type === "PERSONAL_SAVE_PROFILE") {
    const result = await personalAdmin.saveProfile(request.profile)
    await resetTransferRuntime()
    return result
  }
  if (request.type === "PERSONAL_DELETE_PROFILE") {
    const result = await personalAdmin.deleteProfile(request.profileId)
    await resetTransferRuntime()
    return result
  }
  if (request.type === "PERSONAL_CLEAR_ALL") {
    await clearSourcePrepare()
    await resetTransferRuntime()
    await personalAdmin.clearAll()
    await clearBuiltinApiModels()
    await chrome.permissions.remove({
      origins: BUILTIN_API_MODELS.map((model) => `${model.origin}/*`),
    }).catch(() => false)
    await chrome.storage.session.clear()
    await chrome.storage.local.remove(API_MODEL_STORAGE_KEY)
    return null
  }
  if (request.type === "PERSONAL_EXPORT") return personalAdmin.exportData()
  if (request.type === "PERSONAL_EXPORT_RECOVERY") return personalAdmin.exportRecoveryData()
  if (request.type === "PERSONAL_EXPORT_DIAGNOSTICS") return personalAdmin.exportDiagnostics()
  if (request.type === "PERSONAL_GET_AI_SETTINGS") return aiSettingsView()
  if (request.type === "PERSONAL_GET_LLM_LOGS") return personalAdmin.llmLogs()
  if (request.type === "PERSONAL_GET_PREPARE_SOURCE") {
    const session = await transferCommand({ type: "GET_TRANSFER" }) as Session
    return session.sourceTabId === undefined ? null : getSourcePrepare(session.sourceTabId)
  }
  if (request.type === "PERSONAL_PREPARE_SOURCE") {
    const modelId = await selectedApiModelId()
    if (!modelId) throw new Error("This model does not support document extraction. Choose another AI model.")
    const definition = builtinApiModel(modelId)
    if (!definition.supportedTasks.includes("source_extract")) throw new Error("This model does not support document extraction. Choose another AI model.")
    const config = await builtinApiModelConfig(modelId)
    if (!config.hasKey) throw new Error(`Select and configure ${definition.displayName} before preparing the source`)
    if (!await chrome.permissions.contains({ origins: [`${definition.origin}/*`] })) throw new Error("Allow this website before using its AI provider")
    const source = await transferCommand({ type: "GET_TRANSFER" }) as Session
    if (source.sourceTabId === undefined) throw new Error("Select and observe a source page before preparing it")
    const documents = await sourceDocumentsForExtraction(source.sourceTabId, request.documentIds)
    return prepareSource(documents, modelId, new DirectApiProvider(definition, config.model))
  }
  if (request.type === "PERSONAL_UNDO_PREPARE_SOURCE") return undoSourcePrepare(request.sessionId)
  if (request.type === "PERSONAL_CLEAR_PREPARE_SOURCE") return clearSourcePrepare(request.sessionId)
  if (request.type === "PERSONAL_SHOW_PREPARE_EVIDENCE") return showSourcePrepareEvidence(request.sessionId, request.visible)
  if (request.type === "PERSONAL_SET_LOCAL_AI_ENABLED") {
    if (isBuiltinApiModel(request.modelId)) {
      if (request.enabled) {
        const model = BUILTIN_API_MODELS.find((candidate) => candidate.id === request.modelId)!
        const health = await builtinApiHealth(model.id)
        if (health.status !== "ready") throw new Error(health.detail || "Enter the API key in the extension UI")
        const current = await personalAdmin.aiSettings()
        if (current.localModelId && current.localModelEnabled) {
          await personalAdmin.setLocalAiEnabled(false, current.localModelId)
        }
        await chrome.storage.local.set({ [API_MODEL_STORAGE_KEY]: request.modelId })
      } else {
        await chrome.storage.local.remove(API_MODEL_STORAGE_KEY)
      }
      return aiSettingsView()
    }
    if (request.enabled) await chrome.storage.local.remove(API_MODEL_STORAGE_KEY)
    return aiSettingsView(await personalAdmin.setLocalAiEnabled(request.enabled, request.modelId))
  }
  if (request.type === "PERSONAL_CONFIGURE_API_MODEL") {
    await configureBuiltinApiModel(request)
    const current = await personalAdmin.aiSettings()
    if (current.localModelId && current.localModelEnabled) {
      await personalAdmin.setLocalAiEnabled(false, current.localModelId)
    }
    await chrome.storage.local.set({ [API_MODEL_STORAGE_KEY]: request.modelId })
    return aiSettingsView()
  }
  if (request.type === "PERSONAL_REMOVE_API_MODEL") {
    const model = BUILTIN_API_MODELS.find((candidate) => candidate.id === request.modelId)
    await removeBuiltinApiModel(request.modelId)
    if (await selectedApiModelId() === request.modelId) {
      await chrome.storage.local.remove(API_MODEL_STORAGE_KEY)
    }
    if (model) {
      await chrome.permissions.remove({ origins: [`${model.origin}/*`] }).catch(() => false)
    }
    return aiSettingsView()
  }
  if (request.type === "PERSONAL_AI_MATCH_TRANSFER") {
    const session = await transferCommand({ type: "GET_TRANSFER" }) as Session
    if (!session.source) throw new Error("Select a source page before running AI matching")
    const apiModelId = await selectedApiModelId()
    const reusableFields = session.source.fields
      .filter((field) => field.reusable)
    const candidatePaths = reusableFields.map((field) => `${field.group ? `${field.group} / ` : ""}${field.label}`)
    const candidates = reusableFields
      .filter((_field, index) => candidatePaths.indexOf(candidatePaths[index]) === candidatePaths.lastIndexOf(candidatePaths[index]))
      .map((field) => ({
        information_path: `${field.group ? `${field.group} / ` : ""}${field.label}`,
        label_text: field.label,
        group_text: field.group,
        type: field.type,
        value: field.value,
      }))
    const sourceKeys = new Map(reusableFields.map((field) => [
      `${field.group ? `${field.group} / ` : ""}${field.label}`,
      field.instanceKey,
    ]))
    const targets: Extract<TransferCommand, { type: "APPLY_AI_FIELD_MATCHES" }>["targets"] = []
    for (const target of session.targets) {
      const actions = target.plan?.actions ?? []
      const unresolved = actions.filter((action) => action.status === "unmapped")
      if (!unresolved.length) continue
      const matchingContext = actions.filter((action) =>
        action.status === "unmapped" || Boolean(action.sourceInstanceKey))
      const matchingControlIds = new Set(matchingContext.map((action) => action.field.instanceKey))
      const allTargetControls = actions.map((action) => ({
        control_id: action.field.instanceKey,
        tag: "",
        type: action.field.type,
        role: "",
        name: "",
        label: action.field.label,
        label_text: action.field.label,
        group_text: action.field.group,
        placeholder: "",
        required: action.field.required,
        disabled: false,
        current_value: action.field.value,
        checked: null,
        options: action.field.options,
      }))
      const matchingControls = allTargetControls.filter((control) => matchingControlIds.has(control.control_id))
      const controls = unresolved.map((action) => ({
        control_id: action.field.instanceKey,
        tag: "",
        type: action.field.type,
        role: "",
        name: "",
        label: action.field.label,
        label_text: action.field.label,
        group_text: action.field.group,
        placeholder: "",
        required: action.field.required,
        disabled: false,
        current_value: action.field.value,
        checked: null,
        options: action.field.options,
      }))
      const matches = apiModelId
        ? await matchFieldsWithBuiltinApi({
            modelId: apiModelId,
            target: target.title,
            controls,
            allTargetControls: matchingControls,
            candidates,
          })
        : await personalAdmin.matchLocalFields({
            target: target.title,
            controls,
            allTargetControls: matchingControls,
            candidates,
          })
      targets.push({
        targetId: target.id,
        mappings: matches.flatMap((match) => {
          const sourceInstanceKey = sourceKeys.get(match.information_path)
          return sourceInstanceKey ? [{ targetInstanceKey: match.control_id, sourceInstanceKey }] : []
        }),
      })
    }
    if (!targets.length) throw new Error("No unresolved fields are available for AI matching")
    return transferCommand({ type: "APPLY_AI_FIELD_MATCHES", targets })
  }
  if (request.type === "TRANSFER") return transferCommand(request.command)
  if (request.type === "TRANSFER_TAB_READY") return transferTabReady(request.tabId)
  if (request.type === "TRANSFER_INVALIDATE_TAB") return invalidateTransferTab(request.tabId)
  throw new Error("Unsupported workspace request")
}

chrome.tabs.onUpdated.addListener((tabId, changes) => {
  if (changes.status === "loading" || changes.url) void clearSourcePrepare(undefined, tabId).catch(() => undefined)
})
chrome.tabs.onRemoved.addListener((tabId) => { void clearSourcePrepare(undefined, tabId).catch(() => undefined) })

chrome.runtime.onMessage.addListener((request: WorkerRequest, _sender, sendResponse) => {
  void handleWorkspaceRequest(request)
    .then((data) => sendResponse({ ok: true, data } satisfies WorkerResponse<unknown>))
    .catch(async (error) => {
      await reportRuntimeError(error, request.type).catch(() => undefined)
      sendResponse({ ok: false, error: request.type.includes("PREPARE_SOURCE") || request.type === "PERSONAL_SHOW_PREPARE_EVIDENCE"
        ? safePrepareError(error) : errorMessage(error) } satisfies WorkerResponse<never>)
    })
  return true
})
