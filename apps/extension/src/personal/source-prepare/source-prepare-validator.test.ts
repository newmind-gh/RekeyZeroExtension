import { describe, expect, it } from "vitest"
import type { Field } from "../../transfer/types"
import type { PreparedDocument } from "./source-prepare-session"
import { validatePreparedDocuments } from "./document-converter"
import { validateSourceExtraction } from "./source-prepare-validator"
import { sourceExtractionRequest } from "./source-extraction-prompt"

const documents: PreparedDocument[] = [{ id: "doc-1", name: "application.pdf", mediaType: "application/pdf", size: 200,
  textHash: "a".repeat(64), markdown: "Organisation: Example Pty Ltd\nState: NSW", privacy: { findings: [], entityMap: {}, redactedMarkdown: "Organisation: Example Pty Ltd\nState: NSW" } }]
const fields = [{ fieldKey: "field_001", field: { label: "Organisation", value: "" } as Field }]
const found = { fieldKey: "field_001", status: "found", value: "Example Pty Ltd", evidence: [{ documentId: "doc-1", page: null, quote: "Organisation: Example Pty Ltd" }] }
describe("source extraction validation", () => {
  it("requires a short verbatim quote in the referenced document/page", () => {
    expect(validateSourceExtraction({ decisions: [found] }, fields, documents)[0]).toMatchObject({ status: "filled", evidence: [{ documentName: "application.pdf" }] })
    for (const evidence of [[{ ...found.evidence[0], quote: "Invented evidence" }], [{ ...found.evidence[0], page: 2 }], [{ ...found.evidence[0], documentId: "unknown" }],
      [{ ...found.evidence[0], quote: "x".repeat(401) }], []]) {
      expect(validateSourceExtraction({ decisions: [{ ...found, evidence }] }, fields, documents)[0].status).toBe("invalid")
    }
  })
  it("skips ambiguous, absent, duplicated, and executable-shaped decisions", () => {
    expect(validateSourceExtraction({ decisions: [{ ...found, status: "ambiguous", value: null }] }, fields, documents)[0].status).toBe("ambiguous")
    expect(validateSourceExtraction({ decisions: [{ ...found, status: "not_found", value: null }] }, fields, documents)[0].status).toBe("not_found")
    expect(validateSourceExtraction({ decisions: [] }, fields, documents)[0].status).toBe("not_found")
    expect(validateSourceExtraction({ decisions: [found, found] }, fields, documents)[0].status).toBe("invalid")
    expect(validateSourceExtraction({ decisions: [{ ...found, selector: "input", javascript: "alert(1)" }] }, fields, documents)[0].status).toBe("invalid")
    expect(validateSourceExtraction({ decisions: [{ ...found, fieldKey: "unknown" }] }, fields, documents)[0].status).toBe("not_found")
  })
  it("rejects malformed outputs", () => {
    for (const output of [null, [], {}, { decisions: "wrong" }]) expect(() => validateSourceExtraction(output, fields, documents)).toThrow("invalid extraction result")
  })
  it("validates redacted evidence and accepts known atomic placeholders", () => {
    const prepared = [{ ...documents[0], markdown: "Email: customer@example.com",
      privacy: { entityMap: { "[EMAIL_1]": "customer@example.com" }, redactedMarkdown: "Email: [EMAIL_1]", findings: [{ type: "EMAIL", displayName: "Email", placeholder: "[EMAIL_1]" }] } }]
    expect(validateSourceExtraction({ decisions: [{ ...found, value: "customer@example.com",
      evidence: [{ documentId: "doc-1", quote: "Email: customer@example.com" }] }] }, fields, prepared)[0].status).toBe("invalid")
    expect(validateSourceExtraction({ decisions: [{ ...found, value: "[EMAIL_1]",
      evidence: [{ documentId: "doc-1", quote: "Email: [EMAIL_1]" }] }] }, fields, prepared)[0].status).toBe("filled")
  })
  it("sends document content and metadata only, with no populated source values or filenames", () => {
    const request = sourceExtractionRequest([{ fieldKey: "field_001", label: "Organisation", section: "Customer", controlType: "text", required: false, options: [] }], documents)
    expect(request.task).toBe("source_extract")
    expect(JSON.stringify(request.input)).toContain("Organisation: Example Pty Ltd")
    expect(JSON.stringify(request.input)).not.toContain("application.pdf")
    expect(JSON.stringify(request.input)).not.toContain('"value"')
  })
  it("enforces document count, text limits, readable text, page bounds, and unique IDs", () => {
    expect(() => validatePreparedDocuments(documents)).not.toThrow()
    for (const invalid of [[], [documents[0], documents[0]], [{ ...documents[0], markdown: "", privacy: { findings: [], entityMap: {}, redactedMarkdown: "" } }],
      [{ ...documents[0], markdown: "x".repeat(80_001) }], [{ ...documents[0], privacy: undefined }],
      Array.from({ length: 7 }, (_, index) => ({ ...documents[0], id: String(index) }))]) expect(() => validatePreparedDocuments(invalid)).toThrow()
  })
})
