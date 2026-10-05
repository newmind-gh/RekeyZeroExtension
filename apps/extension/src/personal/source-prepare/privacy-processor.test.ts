import { describe, expect, it } from "vitest"
import type { DetectedEntity, EntityType } from "@doccloak/core"
import { redactPrivacyEntities } from "./privacy-engine"

function semanticFixture(text: string, value: string, type: EntityType): DetectedEntity {
  const start = text.indexOf(value)
  return { type, value, start, end: start + value.length, confidence: 0.9, detector: `gliner:${type.toLowerCase()}` }
}

describe("local hybrid privacy redaction", () => {
  // Real semantic inference is exercised by the packaged Chromium suite.
  it.each([
    ["Email: john@example.com", "john@example.com"],
    ["Phone: +1 (415) 555-2671", "+1 (415) 555-2671"],
    ["SSN: 123-45-6789", "123-45-6789"],
    ["Card: 4111 1111 1111 1111", "4111 1111 1111 1111"],
    ["IBAN: GB82 WEST 1234 5698 7654 32", "GB82 WEST 1234 5698 7654 32"],
    ["IP: 192.168.1.10", "192.168.1.10"],
    ["API key: sk-" + "a".repeat(48), "sk-" + "a".repeat(48)],
  ])("redacts a library-supported example: %s", async (markdown, value) => {
    const result = redactPrivacyEntities(markdown, [])
    expect(result.findings.length).toBeGreaterThan(0)
    expect(result.redactedMarkdown).not.toContain(value)
    expect(JSON.stringify(result.findings)).not.toContain(value)
    for (const finding of result.findings) {
      expect(finding.displayName).toBeTruthy()
      expect(result.redactedMarkdown).toContain(finding.placeholder)
    }
  })
  it.each([
    "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xfn\n-----END RSA PRIVATE KEY-----",
    "postgres://admin:S3cr3tPass@db.example.com:5432/mydb",
    'password: "9fQz3kX7Lm2Pw8Rt5Vy1Jh6Nd4Bg0Cs"',
  ])("protects upstream credential patterns locally", (markdown) => {
    const result = redactPrivacyEntities(markdown, [])
    expect(result.findings.map((finding) => finding.type)).toContain("SECRET")
    for (const raw of Object.values(result.entityMap)) expect(result.redactedMarkdown).not.toContain(raw)
    expect(JSON.stringify(result.findings)).not.toContain("S3cr3tPass")
  })
  it("preserves business labels, company, amounts, generic dates and geographic terms", () => {
    const markdown = "Annual turnover: $12,500,000\nBuilding sum insured: $8,500,000\nExample Pty Ltd\n5 October 2026\nSydney NSW\nCommercial Property\nRisk Management"
    const result = redactPrivacyEntities(markdown, [semanticFixture(markdown, "$12,500,000", "CURRENCY"),
      semanticFixture(markdown, "Example Pty Ltd", "COMPANY"), semanticFixture(markdown, "5 October 2026", "DATE"),
      { ...semanticFixture(markdown, "Sydney", "ADDRESS"), detector: "gliner:city" }])
    expect(result.redactedMarkdown).toContain("Annual turnover: $12,500,000")
    expect(result.redactedMarkdown).toContain("Building sum insured: $8,500,000")
    expect(result.redactedMarkdown).toContain("Example Pty Ltd")
    expect(result).toEqual({ findings: [], entityMap: {}, redactedMarkdown: markdown })
  })
  it("does not treat business years followed by headings as postal addresses", () => {
    const markdown = "Start date: 5 October 2026\nSubscribed: Yes\nContact email: customer@example.com"
    const result = redactPrivacyEntities(markdown, [])
    expect(result.redactedMarkdown).toContain("Start date: 5 October 2026\nSubscribed: Yes")
    expect(result.findings.map((finding) => finding.type)).toEqual(["EMAIL"])
  })
  it("does not create findings or a review state for ordinary business text", async () => {
    expect(redactPrivacyEntities("Example Pty Ltd manufactures furniture.", [])).toEqual({
      findings: [], entityMap: {}, redactedMarkdown: "Example Pty Ltd manufactures furniture.",
    })
  })
  it("redacts semantic spans without propagating surnames into company names", () => {
    const markdown = "Applicant: John Smith\nCompany: Smith Engineering Pty Ltd\nAddress: 12 George Street, Sydney NSW 2000"
    const result = redactPrivacyEntities(markdown, [semanticFixture(markdown, "John Smith", "PERSON"),
      semanticFixture(markdown, "12 George Street, Sydney NSW 2000", "ADDRESS")])
    expect(result.redactedMarkdown).not.toContain("John Smith")
    expect(result.redactedMarkdown).not.toContain("12 George Street")
    expect(result.redactedMarkdown).toContain("Smith Engineering Pty Ltd")
    expect(result.findings.every((finding) => Object.keys(finding).sort().join() === "displayName,placeholder,type")).toBe(true)
  })
  it("uses upstream typed placeholders for validated Australian identifiers", () => {
    const markdown = "TFN: 123 456 782\nMedicare: 2123 45670 1\nABN: 51 824 753 556\nACN: 004 085 616"
    const result = redactPrivacyEntities(markdown, [])
    for (const type of ["AU_TFN", "AU_MEDICARE", "AU_ABN", "AU_ACN"]) {
      expect(result.redactedMarkdown).toContain(`[${type}_1]`)
      expect(result.findings).toContainEqual({ type, displayName: type.slice(3), placeholder: `[${type}_1]` })
    }
  })
  it("gives validated AU identifiers precedence over general spans", () => {
    const markdown = "ABN: 51 824 753 556"
    const result = redactPrivacyEntities(markdown, [semanticFixture(markdown, "51 824 753 556", "PHONE")])
    expect(result.redactedMarkdown).toBe("ABN: [AU_ABN_1]")
    expect(result.findings.map((finding) => finding.type)).toEqual(["AU_ABN"])
  })
  it("rejects invalid inference spans before applying the redaction policy", () => {
    const markdown = "Example Pty Ltd"
    expect(() => redactPrivacyEntities(markdown, [{ ...semanticFixture(markdown, markdown, "COMPANY"), start: -1 }])).toThrow("Invalid privacy result")
  })
})
