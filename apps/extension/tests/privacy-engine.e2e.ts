import { chromium, expect, test } from "@playwright/test"
import { readdirSync } from "node:fs"
import { resolve, join } from "node:path"
import { extensionOutputDirectory } from "../build-output"
import type { PrivacyResult } from "../src/personal/source-prepare/source-prepare-session"

test("packaged privacy worker detects semantic PII locally and preserves business data", async () => {
  test.setTimeout(300_000)
  const output = resolve(extensionOutputDirectory())
  const workerFile = readdirSync(join(output, "assets")).find((file) => /^privacy-worker-.*\.js$/.test(file))!
  const context = await chromium.launchPersistentContext(resolve(import.meta.dirname, "../../../output/playwright/privacy-model-browser"), { channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${output}`, `--load-extension=${output}`] })
  const assets: Array<{ url: string; method: string; body: string | null }> = []
  context.on("request", (request) => {
    if (request.url().startsWith("https:")) assets.push({ url: request.url(), method: request.method(), body: request.postData() })
  })
  try {
    const background = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker")
    const page = await context.newPage()
    await page.goto(`chrome-extension://${new URL(background.url()).host}/sidepanel.html`)
    const markdown = `Applicant: John Smith
Contact: Sarah Brown
Contact: Michael Johnson
Address: 12 George Street, Sydney NSW 2000
Postal address: PO Box 123, Parramatta NSW 2150
Address: Level 5, 100 Collins Street, Melbourne VIC 3000
Email: john.smith@example.com
Phone: +61 412 345 678
Card: 4111 1111 1111 1111
IBAN: GB82 WEST 1234 5698 7654 32
IP: 192.168.1.10
TFN: 123 456 782
Medicare: 2123 45670 1
ABN: 51 824 753 556
ACN: 004 085 616
API key: ${"sk-" + "a".repeat(48)}
Company: Smith Engineering Pty Ltd
Company: Brown Brothers Limited
Company: Johnson & Johnson
Company: Example Pty Ltd
Annual turnover: $12,500,000
Building sum insured: $8,500,000
Policy inception: 1 July 2026
Policy expiry: 30 June 2027
Inspection date: 5 October 2026
Region: NSW
Commercial Property
Risk Management`
    const result = await page.evaluate(async ({ workerFile, markdown }) => {
      const worker = new Worker(`assets/${workerFile}`, { type: "module" })
      return await new Promise<PrivacyResult>((resolve, reject) => {
        worker.onerror = (event) => { worker.terminate(); reject(new Error(event.message)) }
        worker.onmessage = (event) => {
          if (event.data.type === "progress") return
          worker.terminate()
          if (event.data.type === "result") resolve(event.data.result)
          else reject(new Error("Privacy worker failed"))
        }
        worker.postMessage({ id: 1, markdown })
      })
    }, { workerFile, markdown })
    for (const value of ["John Smith", "Sarah Brown", "Michael Johnson", "12 George Street", "100 Collins Street", "PO Box 123",
      "john.smith@example.com", "+61 412 345 678", "4111 1111 1111 1111", "GB82 WEST 1234 5698 7654 32", "192.168.1.10",
      "123 456 782", "2123 45670 1", "51 824 753 556", "004 085 616", "sk-" + "a".repeat(48)]) {
      expect(result.redactedMarkdown).not.toContain(value)
      expect(JSON.stringify(result.findings)).not.toContain(value)
    }
    for (const value of ["Smith Engineering Pty Ltd", "Brown Brothers Limited", "Johnson & Johnson", "Example Pty Ltd",
      "$12,500,000", "$8,500,000", "1 July 2026", "30 June 2027", "5 October 2026", "Commercial Property", "Risk Management"]) {
      expect(result.redactedMarkdown).toContain(value)
    }
    expect(result.findings.map((finding) => finding.type)).toContain("PERSON")
    expect(result.findings.map((finding) => finding.type)).toContain("ADDRESS")
    for (const type of ["AU_TFN", "AU_MEDICARE", "AU_ABN", "AU_ACN", "API_KEY"]) {
      expect(result.findings.map((finding) => finding.type)).toContain(type)
    }
    expect(result.redactedMarkdown).toMatch(/Applicant: \[PERSON_\d+\]/)
    for (const asset of assets) { expect(asset.method).toBe("GET"); expect(asset.body).toBeNull(); expect(asset.url).not.toContain("John") }
    // A new worker must initialize from the upstream verified browser cache,
    // even when every remote model request is blocked.
    await context.route("https://**/*", (route) => route.abort())
    const offline = await page.evaluate(async (workerFile) => {
      const worker = new Worker(`assets/${workerFile}`, { type: "module" })
      return await new Promise<PrivacyResult>((resolve, reject) => {
        worker.onerror = () => { worker.terminate(); reject(new Error("Privacy worker unavailable")) }
        worker.onmessage = (event) => {
          if (event.data.type === "progress") return
          worker.terminate()
          if (event.data.type === "result") resolve(event.data.result)
          else reject(new Error("Privacy worker unavailable"))
        }
        worker.postMessage({ id: 2, markdown: "Organisation: Example Pty Ltd\nTurnover: $12.5m\nState: New South Wales\nStart date: 5 October 2026\nSubscribed: Yes\nContact email: customer@example.com\nApplicant: John Smith\nCompany: Smith Engineering Pty Ltd\nPolicy expiry: 30 June 2027" })
      })
    }, workerFile)
    expect(offline.redactedMarkdown).not.toContain("John Smith")
    expect(offline.redactedMarkdown).toContain("Start date: 5 October 2026")
    expect(offline.redactedMarkdown).toContain("Smith Engineering Pty Ltd")
    expect(offline.redactedMarkdown).toContain("30 June 2027")
  } finally { await context.close() }
})
