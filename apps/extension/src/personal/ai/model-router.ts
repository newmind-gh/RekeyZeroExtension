import type { PageControl } from "../../shared/types"
import { getStored } from "../storage/indexed-db"
import type { PersonalSettings } from "../storage/schema"
import { assertRequestedRoute, routeTask } from "../core/capability-gate"
import type { CapabilityDecision } from "../core/capability-gate"
import { fieldIdentity, LOCAL_FIELD_MATCH_PROMPT, localFieldMatchInput } from "./field-match-prompt"
import type { LocalFieldMatchOutput } from "./field-match-prompt"
import { LocalModelProvider } from "./local-model-provider"
import type { PersonalModelProvider } from "./model-provider"
import type { ModelRequest } from "./model-provider"
import type { SourceFieldCandidate } from "./semantic-matcher"

export type FieldMatch = {
  control_id: string
  information_path: string
  confidence: "high" | "medium" | "low"
}

type RejectedLocalMapping = LocalFieldMatchOutput["decisions"][number] & {
  reason: "invalid_identity" | "ambiguous_identity" | "duplicate_target"
}

type TimedModelRequest = ModelRequest & {
  timing: {
    request_started_at: string
    response_received_at: string
    elapsed_ms: number
  }
}

export class PersonalModelRouter {
  constructor(
    private readonly localProvider: (modelId: string) => PersonalModelProvider =
      (modelId) => new LocalModelProvider(modelId),
  ) {}

  async decision(input: {
    destinationFieldCount: number
    unresolvedFieldCount: number
    contextChars: number
  }): Promise<CapabilityDecision> {
    const settings = await getStored<PersonalSettings>("settings", "personal")
    const localProvider = settings?.localModelEnabled && settings.localModelId
      ? this.localProvider(settings.localModelId)
      : null
    const health = localProvider ? await localProvider.health() : null
    return routeTask({
      destinationFieldCount: input.destinationFieldCount,
      unresolvedFieldCount: input.unresolvedFieldCount,
      contextChars: input.contextChars,
      webgpuAvailable: typeof navigator !== "undefined" && "gpu" in navigator,
      localModelReady: health?.status === "ready",
    })
  }

  async matchFields(input: {
    route: "local_lite"
    controls: PageControl[]
    candidates: SourceFieldCandidate[]
    decision: CapabilityDecision
  }): Promise<{ matches: FieldMatch[]; invalidMappings: RejectedLocalMapping[]; providerId: string; modelId: string; request: TimedModelRequest; response: LocalFieldMatchOutput; rawResponses: string[] }> {
    const settings = await getStored<PersonalSettings>("settings", "personal")
    assertRequestedRoute(input.decision, input.route)
    const localInput = localFieldMatchInput(input.controls, input.candidates)
    if (!input.candidates.length) throw new Error("No approved candidate facts are available for AI")

    if (!settings?.localModelEnabled || !settings.localModelId) throw new Error("Local AI is not enabled")
    const provider = this.localProvider(settings.localModelId)
    if ((await provider.health()).status !== "ready") throw new Error("Local AI is not ready")

    const localSchema = {
      type: "object",
      additionalProperties: false,
      required: ["decisions"],
      properties: {
        decisions: {
          type: "array",
          minItems: localInput.targetFields.length,
          maxItems: localInput.targetFields.length,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["source", "target"],
            properties: {
              source: { enum: [...localInput.sourceFields.map((field) => field.identity), null] },
              target: { type: "string", enum: localInput.targetFields.map((field) => field.identity) },
            },
          },
        },
      },
    }
    const request: ModelRequest = {
      task: "field_match",
      system: LOCAL_FIELD_MATCH_PROMPT,
      input: localInput.indexedText,
      schema: localSchema,
      maxTokens: Math.min(1_024, 128 + input.controls.length * 64),
    }

    const requestStartedAt = new Date()
    const startedMs = performance.now()
    const result = await provider.completeJson<LocalFieldMatchOutput>(request)
    const responseReceivedAt = new Date()
    const timedRequest: TimedModelRequest = {
      ...request,
      timing: {
        request_started_at: requestStartedAt.toISOString(),
        response_received_at: responseReceivedAt.toISOString(),
        elapsed_ms: Math.round((performance.now() - startedMs) * 100) / 100,
      },
    }

    let responseMatches: FieldMatch[]
    const invalidMappings: RejectedLocalMapping[] = []
    const output = result.output as LocalFieldMatchOutput
    if (!output || !Array.isArray(output.decisions)) throw new Error("AI returned an invalid match result")
    const targetDecisionCounts = new Map<string, number>()
    output.decisions.forEach((decision) => {
      if (typeof decision?.target !== "string") return
      targetDecisionCounts.set(decision.target, (targetDecisionCounts.get(decision.target) ?? 0) + 1)
    })
    responseMatches = output.decisions.flatMap((decision) => {
      const targets = typeof decision?.target === "string"
        ? input.controls.filter((control) =>
            fieldIdentity(control.label_text ?? control.label, control.group_text ?? "") === decision.target
          )
        : []
      if (targets.length !== 1) {
        const reason = targets.length > 1 ? "ambiguous_identity" as const : "invalid_identity" as const
        invalidMappings.push({ ...decision, reason })
        return []
      }
      if ((targetDecisionCounts.get(decision.target) ?? 0) > 1) {
        invalidMappings.push({ ...decision, reason: "duplicate_target" })
        return []
      }
      if (decision.source === null) return []
      const sources = typeof decision.source === "string"
        ? input.candidates.filter((candidate) =>
            fieldIdentity(candidate.label_text ?? candidate.information_path, candidate.group_text ?? "") === decision.source
          )
        : []
      if (sources.length !== 1) {
        const reason = sources.length > 1 ? "ambiguous_identity" as const : "invalid_identity" as const
        invalidMappings.push({ ...decision, reason })
        return []
      }
      return [{
        control_id: targets[0].control_id,
        information_path: sources[0].information_path,
        confidence: "high" as const,
      }]
    })
    return {
      matches: responseMatches.filter((match) => match.confidence === "high"),
      invalidMappings,
      providerId: result.providerId,
      modelId: result.modelId,
      request: timedRequest,
      response: result.output,
      rawResponses: result.rawResponses,
    }
  }
}
