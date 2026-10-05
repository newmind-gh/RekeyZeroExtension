import { describe, expect, it } from "vitest"
import type { Field } from "../../transfer/types"
import { isBlankSourceValue, normalizeSourceValue } from "./source-value-normalizer"

const field = (type: string, options: Field["options"] = []) => ({ type, writable: true, options }) as Field
describe("source value normalization", () => {
  it.each([["  Example  Pty\nLtd ", "Example Pty Ltd"], [123, "123"]])("normalizes text %s", (input, expected) => {
    expect(normalizeSourceValue(input, field("text"))).toBe(expected)
  })
  it.each([["$12.5m", "12500000"], ["1.2k", "1200"], ["3.5m", "3500000"], ["1,250,000", "1250000"],
    ["1234567890123456", "1234567890123456"], ["1.23456k", "1234.56"], ["0.1234567890123456", "0.1234567890123456"], [-12.5, "-12.5"]])("normalizes number %s without rounding", (input, expected) => {
    expect(normalizeSourceValue(input, field("number"))).toBe(expected)
  })
  it.each(["12,34", "roughly 12m", "1e7", "12.5 million", Infinity, Number.MAX_SAFE_INTEGER + 1, true])("rejects unsafe numeric value %s", (value) => {
    expect(normalizeSourceValue(value, field("number"))).toBeUndefined()
  })
  it.each([["Yes", true], ["no", false], ["True", true], ["False", false], [false, false]])("normalizes checkbox %s", (input, expected) => {
    expect(normalizeSourceValue(input, field("checkbox"))).toBe(expected)
  })
  it.each([["5 October 2026", "2026-10-05"], ["2024-02-29", "2024-02-29"]])("normalizes unique date %s", (input, expected) => {
    expect(normalizeSourceValue(input, field("date"))).toBe(expected)
  })
  it.each(["05/06/2026", "2026-02-29", "31 April 2026", "2026-13-01", "October-ish 2026"])("rejects ambiguous/invalid date %s", (input) => {
    expect(normalizeSourceValue(input, field("date"))).toBeUndefined()
  })
  it("matches only unique current options, including deterministic state aliases", () => {
    const select = field("select", [{ value: "NSW", label: "NSW" }, { value: "VIC", label: "VIC" }])
    expect(normalizeSourceValue("New South Wales", select)).toBe("NSW")
    expect(normalizeSourceValue("Eastern Australia", select)).toBeUndefined()
    expect(normalizeSourceValue("A", field("radio", [{ value: "one", label: "A" }, { value: "two", label: "A" }]))).toBeUndefined()
  })
  it("rejects null, unsupported controls, read-only fields, and oversized text", () => {
    expect(normalizeSourceValue(null, field("text"))).toBeUndefined()
    expect(normalizeSourceValue("text", { ...field("text"), writable: false })).toBeUndefined()
    expect(normalizeSourceValue("x", field("hidden"))).toBeUndefined()
    expect(normalizeSourceValue("x".repeat(10_001), field("text"))).toBeUndefined()
  })
  it("distinguishes blanks from populated values", () => {
    for (const value of [null, "", "  ", false]) expect(isBlankSourceValue(value)).toBe(true)
    for (const value of ["0", "false", true, "Existing value"]) expect(isBlankSourceValue(value)).toBe(false)
  })
})
