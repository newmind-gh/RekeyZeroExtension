const SESSION_PREFIX = "personalProviderKey:"
const LOCAL_PREFIX = "personalRememberedProviderKey:"

type BoundProviderCredential = {
  apiKey: string
  origin: string
}

export function canonicalProviderOrigin(baseUrl: string): string {
  return new URL(baseUrl).origin.toLowerCase()
}

async function lockLocalStorage(): Promise<void> {
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
}

export async function saveProviderKey(
  providerId: string,
  baseUrl: string,
  apiKey: string,
): Promise<void> {
  await lockLocalStorage()
  await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  const credential: BoundProviderCredential = {
    apiKey,
    origin: canonicalProviderOrigin(baseUrl),
  }
  await chrome.storage.session.set({ [`${SESSION_PREFIX}${providerId}`]: credential })
  await chrome.storage.local.remove(`${LOCAL_PREFIX}${providerId}`)
}

function validCredential(value: unknown, origin: string): value is BoundProviderCredential {
  return Boolean(
    value
    && typeof value === "object"
    && (value as BoundProviderCredential).origin === origin
    && typeof (value as BoundProviderCredential).apiKey === "string",
  )
}

export async function getProviderKey(providerId: string, baseUrl: string): Promise<string | null> {
  await lockLocalStorage()
  await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  const origin = canonicalProviderOrigin(baseUrl)
  const sessionKey = `${SESSION_PREFIX}${providerId}`
  const rememberedKey = `${LOCAL_PREFIX}${providerId}`
  const session = await chrome.storage.session.get(sessionKey)
  if (validCredential(session[sessionKey], origin)) {
    await chrome.storage.local.remove(rememberedKey)
    return session[sessionKey].apiKey
  }
  if (session[sessionKey] !== undefined) await chrome.storage.session.remove(sessionKey)
  const local = await chrome.storage.local.get(rememberedKey)
  const remembered = local[rememberedKey]
  if (validCredential(remembered, origin)) {
    await chrome.storage.session.set({ [sessionKey]: remembered })
    await chrome.storage.local.remove(rememberedKey)
    return remembered.apiKey
  }
  if (remembered !== undefined) await chrome.storage.local.remove(rememberedKey)
  return null
}


export async function deleteProviderKey(providerId: string): Promise<void> {
  await chrome.storage.session.remove(`${SESSION_PREFIX}${providerId}`)
  await chrome.storage.local.remove(`${LOCAL_PREFIX}${providerId}`)
}
