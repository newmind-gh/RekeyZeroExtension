import type { PageCommand, PageReply } from "./types"

export function siteOrigin(raw: string): string {
  const url = new URL(raw)
  if (url.username || url.password || !(url.protocol === "https:" || (url.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(url.hostname)))) throw new Error("Unsupported website URL")
  return url.origin
}
export async function guardedPageRequest(transferId: string, tabId: number, targetId: string, operation: PageCommand["operation"], extra: Partial<PageCommand> = {}): Promise<PageReply> {
  const tab = await chrome.tabs.get(tabId)
  const origin = siteOrigin(tab.url ?? "")
  if (!await chrome.permissions.contains({ origins: [`${origin}/*`] })) throw new Error("Allow this website before reading or filling")
  try { await chrome.tabs.sendMessage(tabId, { type: "PING" }, { frameId: 0 }) }
  catch { await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ["content-script.js"] }) }
  const request: PageCommand = { type: "TRANSFER_PAGE", operation, transferId, targetId, tabId,
    documentEpoch: "", requestId: crypto.randomUUID(), ...extra }
  let timeout: ReturnType<typeof setTimeout> | undefined
  const reply = await Promise.race([
    chrome.tabs.sendMessage<PageCommand, PageReply>(tabId, request, { frameId: 0 }),
    new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Page timed out; result is unknown until checked")), 15000) }),
  ]).finally(() => clearTimeout(timeout))
  if (!reply?.ok) throw new Error(reply?.error || "Page did not respond")
  if (reply.envelope.requestId !== request.requestId || reply.envelope.tabId !== tabId || reply.envelope.transferId !== transferId ||
    reply.envelope.targetId !== targetId || (request.documentEpoch && reply.envelope.documentEpoch !== request.documentEpoch)) throw new Error("Page response identity mismatch")
  return reply
}
