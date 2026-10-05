import { describe, expect, it } from "vitest"
import type { Field } from "../../transfer/types"
import type { ParsedDocument } from "./source-prepare-session"
import { validateParsedDocuments } from "./document-parser"
import { validateSourceExtraction } from "./source-prepare-validator"
import { sourceExtractionRequest } from "./source-extraction-prompt"

const documents: ParsedDocument[] = [{ id: "doc-1", name: "application.pdf", mediaType: "application/pdf", size: 200,
  textHash: "a".repeat(64), pages: [{ page: 1, text: "Organisation: Example Pty Ltd\nState: NSW" }] }]
const fields = [{ fieldKey: "field_001", field: { label: "Organisation", value: "" } as Field }]
const found = { fieldKey: "field_001", status: "found", value: "Example Pty Ltd", evidence: [{ documentId: "doc-1", page: 1, quote: "Organisation: Example Pty Ltd" }] }
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
  it("sends document content and metadata only, with no populated source values or filenames", () => {
    const request = sourceExtractionRequest([{ fieldKey: "field_001", label: "Organisation", section: "Customer", controlType: "text", required: false, options: [] }], documents)
    expect(request.task).toBe("source_extract")
    expect(JSON.stringify(request.input)).toContain("Organisation: Example Pty Ltd")
    expect(JSON.stringify(request.input)).not.toContain("application.pdf")
    expect(JSON.stringify(request.input)).not.toContain('"value"')
  })
  it("enforces document count, text limits, readable text, page bounds, and unique IDs", () => {
    expect(() => validateParsedDocuments(documents)).not.toThrow()
    for (const invalid of [[], [documents[0], documents[0]], [{ ...documents[0], pages: [{ text: "" }] }],
      [{ ...documents[0], pages: [{ text: "x".repeat(80_001) }] }], [{ ...documents[0], pages: [{ page: -1, text: "content" }] }],
      Array.from({ length: 7 }, (_, index) => ({ ...documents[0], id: String(index) }))]) expect(() => validateParsedDocuments(invalid)).toThrow()
  })
})
