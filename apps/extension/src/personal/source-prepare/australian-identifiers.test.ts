import { describe, expect, it } from "vitest"
import { detectAustralianIdentifiers } from "./australian-identifiers"

const examples = [
  ["TFN", "123 456 782", "AU_TFN"],
  ["Medicare", "2123 45670 1", "AU_MEDICARE"],
  ["ABN", "51 824 753 556", "AU_ABN"],
  ["ACN", "004 085 616", "AU_ACN"],
] as const

describe("Australian checksum recognizers", () => {
  it.each(examples)("detects labeled %s in grouped and compact form", (label, value, type) => {
    for (const formatted of [value, value.replaceAll(" ", "")]) {
      const text = `Business application\n${label}: ${formatted}\nEnd.`
      const spans = detectAustralianIdentifiers(text)
      expect(spans).toEqual([{ type, start: text.indexOf(formatted), end: text.indexOf(formatted) + formatted.length }])
    }
  })
  it.each(examples)("rejects a wrong checksum for %s", (label, value) => {
    // Medicare's ninth digit is the checksum; its last digit is the issue.
    const position = label === "Medicare" ? value.length - 3 : value.length - 1
    const invalid = value.slice(0, position) + ((Number(value[position]) + 1) % 10) + value.slice(position + 1)
    expect(detectAustralianIdentifiers(`${label}: ${invalid}`)).toEqual([])
  })
  it.each(examples)("recognizes the standard grouped %s format without a label", (_label, value, type) => {
    const text = `Identifier (${value}).`
    expect(detectAustralianIdentifiers(text)).toEqual([{ type, start: text.indexOf(value), end: text.indexOf(value) + value.length }])
  })
  it("does not scan a partial run of numeric groups", () => {
    expect(detectAustralianIdentifiers("999 123 456 782 999")).toEqual([])
  })
  it.each(examples)("does not detect a fragment of a longer %s identifier", (label, value) => {
    expect(detectAustralianIdentifiers(`${label}: ${value}0`)).toEqual([])
    expect(detectAustralianIdentifiers(`${label}: ${value}X`)).toEqual([])
    expect(detectAustralianIdentifiers(`prefix${label}: ${value.replaceAll(" ", "")}`)).toEqual([])
    expect(detectAustralianIdentifiers(`é${label}: ${value.replaceAll(" ", "")}`)).toEqual([])
  })
  it("keeps commercial amounts and unrelated numeric references", () => {
    const text = `Policy number: 123456789\nClaim number: 004085616\nPremium: 123456782
Postcode: 2000\nSum insured: 51824753556\nReference ID: 2123456701`
    expect(detectAustralianIdentifiers(text)).toEqual([])
  })
  it("handles several identifiers with full labels and preserves offsets", () => {
    const text = "Tax file number: 123456782; Medicare number: 2123456701; Australian business number: 51824753556; Australian company number: 004085616"
    expect(detectAustralianIdentifiers(text).map((span) => [span.type, text.slice(span.start, span.end)])).toEqual([
      ["AU_TFN", "123456782"], ["AU_MEDICARE", "2123456701"], ["AU_ABN", "51824753556"], ["AU_ACN", "004085616"],
    ])
  })
  it("accepts ACN's zero check digit and rejects all-zero candidates", () => {
    expect(detectAustralianIdentifiers("ACN: 100000020").map((span) => span.type)).toEqual(["AU_ACN"])
    expect(detectAustralianIdentifiers("TFN: 000000000; ACN: 000000000; Medicare: 0123456789")).toEqual([])
  })
})
