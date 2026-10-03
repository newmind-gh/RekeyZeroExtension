import { describe, expect, it } from "vitest"

import { assertRequestedRoute, routeTask } from "./capability-gate"

const base = {
  destinationFieldCount: 30,
  unresolvedFieldCount: 12,
  contextChars: 12_000,
  webgpuAvailable: true,
  localModelReady: true,
}

describe("Personal capability gate", () => {
  it("uses Local Lite at the documented boundaries", () => {
    expect(routeTask(base).route).toBe("local_lite")
  })

  it("requires a human beyond local limits without a provider", () => {
    expect(routeTask({ ...base, destinationFieldCount: 31 }).route).toBe("human_required")
    expect(routeTask({ ...base, unresolvedFieldCount: 13 }).route).toBe("human_required")
  })


  it("uses deterministic matching when every field is resolved", () => {
    expect(routeTask({ ...base, unresolvedFieldCount: 0 }).route).toBe("deterministic")
  })

  it.each([
    { destinationFieldCount: 31 },
    { unresolvedFieldCount: 13 },
    { contextChars: 12_001 },
  ])("rejects forced Local Lite outside its envelope: $destinationFieldCount fields", (override) => {
    const decision = routeTask({ ...base, ...override })
    expect(() => assertRequestedRoute(decision, "local_lite")).toThrow("outside")
  })

  it("rejects forced Local Lite when the model is disabled or unavailable", () => {
    const decision = routeTask({ ...base, localModelReady: false })
    expect(() => assertRequestedRoute(decision, "local_lite")).toThrow("outside")
  })
})
