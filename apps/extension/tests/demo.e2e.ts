import { chromium, expect, test } from "@playwright/test"
import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { resolve, sep } from "node:path"

test("static demo works under a repository base path and submits only local previews", async () => {
  const root = resolve("../../dist/demo")
  const base = process.env.REKEYZERO_DEMO_BASE_PATH ?? "/RekeyZeroExtension"
  const prefix = base === "/" ? "" : base
  const server = createServer(async (request, response) => {
    const path = new URL(request.url!, "http://localhost").pathname
    if (!path.startsWith(`${prefix}/`)) { response.writeHead(404).end(); return }
    const local = resolve(root, `.${path.slice(prefix.length)}`)
    if (local !== root && !local.startsWith(`${root}${sep}`)) { response.writeHead(403).end(); return }
    try {
      const file = /\.(js|webm)$/.test(local) ? local : resolve(local, "index.html")
      response.setHeader("content-type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".webm") ? "video/webm" : "text/html")
      response.end(await readFile(file))
    } catch { response.writeHead(404).end() }
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`
  const browser = await chromium.launch()
  const page = await browser.newPage()
  const failed: string[] = []
  page.on("response", (response) => { if (response.status() >= 400) failed.push(response.url()) })
  try {
    await page.goto(`${origin}${prefix}/`)
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Stop re-keying between business portals.")
    await expect(page.locator("video")).toHaveAttribute("controls", "")
    await page.getByRole("link", { name: "Try the synthetic portals" }).click()
    await expect(page.getByRole("link", { name: /System Alpha/ })).toHaveAttribute("href", `${prefix}/transfer-demo/source`)
    await page.goto(`${origin}${prefix}/transfer-demo/delta/`)
    await expect(page.getByRole("combobox", { name: "State", exact: true })).toBeVisible()
    await page.getByRole("combobox", { name: "State", exact: true }).click()
    await page.getByRole("option", { name: "New South Wales" }).click()
    await expect(page.getByRole("status")).toContainText('"state":"AU-NSW"')
    await page.getByRole("button", { name: "Submit", exact: true }).click()
    await expect(page.getByRole("dialog")).toBeVisible()
    await page.goto(`${origin}${prefix}/adapter-controls/`)
    await expect(page.frameLocator("iframe").getByRole("textbox").first()).toBeVisible()
    expect(failed).toEqual([])
  } finally {
    await browser.close()
    await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()))
  }
})
