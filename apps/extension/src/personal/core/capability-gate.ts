export type CapabilityInput = {
  destinationFieldCount: number
  unresolvedFieldCount: number
  contextChars: number
  webgpuAvailable: boolean
  localModelReady: boolean
}

export type CapabilityDecision =
  | { route: "deterministic" }
  | { route: "local_lite"; reason: string }
  | { route: "human_required"; reason: string }

export type CapabilityLimits = {
  localDestinationFields: number
  localUnresolvedFields: number
  localContextChars: number
}

export const DEFAULT_CAPABILITY_LIMITS: CapabilityLimits = {
  localDestinationFields: 30,
  localUnresolvedFields: 12,
  localContextChars: 12_000,
}

export function routeTask(
  input: CapabilityInput,
  limits: CapabilityLimits = DEFAULT_CAPABILITY_LIMITS,
): CapabilityDecision {
  if (input.unresolvedFieldCount === 0) return { route: "deterministic" }
  const withinLocalLimits = input.destinationFieldCount <= limits.localDestinationFields
    && input.unresolvedFieldCount <= limits.localUnresolvedFields
    && input.contextChars <= limits.localContextChars
  if (input.webgpuAvailable && input.localModelReady && withinLocalLimits) {
    return { route: "local_lite", reason: "within_local_limits" }
  }
  return { route: "human_required", reason: "local_capability_exceeded" }
}

export function assertRequestedRoute(
  decision: CapabilityDecision,
  requestedRoute: "local_lite",
): void {
  if (decision.route !== requestedRoute) {
    throw new Error("Requested AI route is outside the supported capability envelope")
  }
}
