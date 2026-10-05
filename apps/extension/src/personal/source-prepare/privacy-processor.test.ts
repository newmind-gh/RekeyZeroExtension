import { describe, expect, it } from "vitest"
import { processPrivacy } from "./privacy-processor"

describe("standard local Tier-0 privacy processing", () => {
  it.each([
    ["Email: john@example.com", "john@example.com"],
    ["Phone: +1 (415) 555-2671", "+1 (415) 555-2671"],
    ["SSN: 123-45-6789", "123-45-6789"],
    ["Card: 4111 1111 1111 1111", "4111 1111 1111 1111"],
    ["IBAN: GB82 WEST 1234 5698 7654 32", "GB82 WEST 1234 5698 7654 32"],
    ["IP: 192.168.1.10", "192.168.1.10"],
  ])("redacts a library-supported example: %s", async (markdown, value) => {
    const result = await processPrivacy(markdown)
    expect(result.findings.length).toBeGreaterThan(0)
    expect(result.redactedMarkdown).not.toContain(value)
    expect(JSON.stringify(result.findings)).not.toContain(value)
    for (const finding of result.findings) {
      expect(finding.displayName).toBeTruthy()
      expect(result.redactedMarkdown).toContain(finding.placeholder)
    }
  })
  it("preserves business labels, company and amounts while retaining standard date redaction", async () => {
    const result = await processPrivacy("Annual turnover: $12,500,000\nBuilding sum insured: $8,500,000\nExample Pty Ltd\n5 October 2026")
    expect(result.redactedMarkdown).toContain("Annual turnover: $12,500,000")
    expect(result.redactedMarkdown).toContain("Building sum insured: $8,500,000")
    expect(result.redactedMarkdown).toContain("Example Pty Ltd")
    expect(result.redactedMarkdown).not.toContain("5 October 2026")
    expect(result.findings.map((finding) => finding.type)).toEqual(["sensitive_date"])
  })
  it("does not create findings or a review state for ordinary business text", async () => {
    expect(await processPrivacy("Example Pty Ltd manufactures furniture.")).toEqual({
      findings: [], redactedMarkdown: "Example Pty Ltd manufactures furniture.",
    })
  })
})
