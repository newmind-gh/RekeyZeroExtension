import { readFile } from "node:fs/promises"
import { describe, expect, it, vi } from "vitest"
import { officeBuffer, pdfBuffer } from "./source-document-fixtures"
import { convertSourceDocument, prepareSourceDocument, SCANNED_PDF_ERROR } from "../src/personal/source-prepare/document-converter"

// Unit tests do not load a browser or ML model. Packaged E2E tests exercise
// the real worker; conversion integration uses real structured redaction here.
vi.mock("../src/personal/source-prepare/privacy-processor", async (original) => ({
  ...await original(),
  processPrivacy: async (markdown: string) => (await import("../src/personal/source-prepare/privacy-engine")).redactPrivacyEntities(markdown, []),
}))

// Exercise the real converter. Node supplies local WASM bytes instead of the
// extension URL; the browser E2E separately verifies packaged asset loading.
vi.mock("docling.rs-wasm/web", async (original) => {
  const module = await original<typeof import("docling.rs-wasm/web")>()
  return { ...module, convert: vi.fn(module.convert), default: async () => module.default({
    module_or_path: await readFile(new URL("../node_modules/docling.rs-wasm/web/docling_wasm_bg.wasm", import.meta.url)),
  }) }
})

vi.mock("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url", () => ({ default: new URL("../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).href }))

describe("local digital document conversion", () => {
  it.each([
    ["txt", "Organisation: Example Pty Ltd"], ["md", "# Organisation\nExample Pty Ltd"],
    ["markdown", "# Organisation\nExample Pty Ltd"],
    ["html", "<h1>Organisation</h1><p>Example Pty Ltd</p>"],
    ["csv", "Organisation,State\nExample Pty Ltd,NSW"],
    ["eml", "Subject: Application\r\nFrom: customer@example.com\r\nContent-Type: text/plain\r\n\r\nOrganisation: Example Pty Ltd"],
  ])("converts %s to usable Markdown", async (extension, text) => {
    expect((await convertSourceDocument(new File([text], `application.${extension}`))).markdown).toContain("Example Pty Ltd")
  })
  it.each(["docx", "xlsx", "pptx"] as const)("converts digital %s using the real WASM", async (extension) => {
    expect((await convertSourceDocument(new File([new Uint8Array(officeBuffer(extension))], `application.${extension}`))).markdown).toContain("Example Pty Ltd")
  })
  it("reads text PDF and rejects a PDF without text", async () => {
    const bytes = pdfBuffer("Organisation: Example Pty Ltd")
    expect((await convertSourceDocument(new File([new Uint8Array(bytes)], "application.pdf"))).markdown).toContain("Example Pty Ltd")
    await expect(convertSourceDocument(new File([new Uint8Array(pdfBuffer())], "scan.pdf"))).rejects.toThrow(SCANNED_PDF_ERROR)
  })
  it("prepares only local privacy output and hashes it", async () => {
    const document = await prepareSourceDocument(new File(["Organisation: Example Pty Ltd\nEmail: customer@example.com"], "application.txt"))
    expect(document.markdown).toContain("customer@example.com")
    expect(document.privacy.redactedMarkdown).not.toContain("customer@example.com")
    expect(document.textHash).toMatch(/^[a-f0-9]{64}$/)
  })
  it("tries the local PDF text reader regardless of Docling's failure wording", async () => {
    const module = await import("docling.rs-wasm/web")
    vi.mocked(module.convert).mockImplementationOnce(() => { throw new Error("Unexpected converter failure") })
    const bytes = pdfBuffer("Organisation: Example Pty Ltd")
    expect((await convertSourceDocument(new File([new Uint8Array(bytes)], "application.pdf"))).markdown).toContain("Example Pty Ltd")
  })
  it("rejects unsupported, empty and excessive documents safely", async () => {
    await expect(convertSourceDocument(new File(["content"], "file.msg"))).rejects.toThrow("Unsupported document format")
    await expect(convertSourceDocument(new File(["content"], "file.png"))).rejects.toThrow("Unsupported document format")
    await expect(convertSourceDocument(new File([], "empty.txt"))).rejects.toThrow("between 1 byte and 10 MB")
    await expect(convertSourceDocument(new File(["x".repeat(80_001)], "large.txt"))).rejects.toThrow("too large")
  })
})
