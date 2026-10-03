import { PERSONAL_STORES } from "./schema"
import type { PersonalStoreName } from "./schema"

export const PERSONAL_DATABASE_NAME = "rekeyzero-personal"
export const PERSONAL_DATABASE_VERSION = 8

const CURRENT_LOCAL_MODEL_IDS = new Set([
  "personal-qwen25-15b-v1",
  "personal-gemma2-2b-it-v1",
])
const DEFAULT_LOCAL_MODEL_ID = "personal-qwen25-15b-v1"

const RETIRED_PERSONAL_STORES = [
  "records",
  "revisions",
  "evidence",
  "provider_configs",
  "destinations",
  "mappings",
  "browser_tasks",
  "actions",
  "executions",
  "events",
  "transfer_mappings",
  "transfer_target_groups",
] as const

export function upgradePersonalDatabase(
  database: IDBDatabase,
  transaction: IDBTransaction,
  oldVersion: number,
): void {
  if (oldVersion < 1) {
    for (const store of PERSONAL_STORES) {
      if (!database.objectStoreNames.contains(store)) {
        database.createObjectStore(store, { keyPath: "id" })
      }
    }
  }
  if (!database.objectStoreNames.contains("transfer_mapping_profiles")) {
    database.createObjectStore("transfer_mapping_profiles", { keyPath: "id" })
  }
  if (!database.objectStoreNames.contains("llm_logs")) {
    database.createObjectStore("llm_logs", { keyPath: "id" })
  }
  for (const store of RETIRED_PERSONAL_STORES) {
    if (database.objectStoreNames.contains(store)) database.deleteObjectStore(store)
  }
}

export function openVersionedPersonalDatabase(
  databaseName = PERSONAL_DATABASE_NAME,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false
    const request = indexedDB.open(databaseName, PERSONAL_DATABASE_VERSION)
    request.onupgradeneeded = (event) => {
      upgradePersonalDatabase(request.result, request.transaction!, event.oldVersion)
    }
    request.onsuccess = () => {
      if (settled) {
        request.result.close()
        return
      }
      settled = true
      resolve(request.result)
    }
    request.onerror = () => {
      if (settled) return
      settled = true
      reject(request.error ?? new Error("Workspace storage is unavailable"))
    }
    request.onblocked = () => {
      if (settled) return
      settled = true
      reject(new Error("Workspace storage upgrade is blocked"))
    }
  })
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("Workspace storage request failed"))
  })
}

function normalizeCurrentValue<T>(storeName: PersonalStoreName, value: T): T {
  if (!value || typeof value !== "object") return value
  const candidate = value as Record<string, unknown>
  if (storeName === "settings" && candidate.id === "personal") {
    const localModelId = typeof candidate.localModelId === "string" ? candidate.localModelId : null
    return {
      id: "personal",
      localModelId: localModelId && CURRENT_LOCAL_MODEL_IDS.has(localModelId) ? localModelId : DEFAULT_LOCAL_MODEL_ID,
      localModelEnabled: Boolean(candidate.localModelEnabled),
      apiModelId: candidate.apiModelId ?? null,
    } as T
  }
  if (storeName === "llm_logs" && !("raw_request" in candidate)) {
    return { ...candidate, raw_request: candidate.ai_request ?? null } as T
  }
  return value
}

export function createPersonalDatabaseOpener(
  databaseName = PERSONAL_DATABASE_NAME,
): () => Promise<IDBDatabase> {
  let opening: Promise<IDBDatabase> | null = null
  return () => {
    if (opening) return opening
    const attempt = openVersionedPersonalDatabase(databaseName)
      .then((database) => {
        database.onversionchange = () => {
          database.close()
          opening = null
        }
        return database
      })
      .catch((error: unknown) => {
        if (opening === attempt) opening = null
        throw error
      })
    opening = attempt
    return attempt
  }
}

const openDefaultPersonalDatabase = createPersonalDatabaseOpener()

export function openPersonalDatabase(): Promise<IDBDatabase> {
  return openDefaultPersonalDatabase()
}

export async function getStored<T>(storeName: PersonalStoreName, id: string): Promise<T | undefined> {
  const database = await openPersonalDatabase()
  const transaction = database.transaction(storeName, "readonly")
  const value = await requestResult(transaction.objectStore(storeName).get(id)) as T | undefined
  return value === undefined ? undefined : normalizeCurrentValue(storeName, value)
}

export async function getAllStored<T>(storeName: PersonalStoreName): Promise<T[]> {
  const database = await openPersonalDatabase()
  const transaction = database.transaction(storeName, "readonly")
  const values = await requestResult(transaction.objectStore(storeName).getAll()) as T[]
  return values.map((value) => normalizeCurrentValue(storeName, value))
}

export async function putStored<T>(storeName: PersonalStoreName, value: T): Promise<T> {
  const database = await openPersonalDatabase()
  const transaction = database.transaction(storeName, "readwrite")
  const normalized = normalizeCurrentValue(storeName, value)
  await requestResult(transaction.objectStore(storeName).put(normalized))
  return normalized
}

export async function deleteStored(storeName: PersonalStoreName, id: string): Promise<void> {
  const database = await openPersonalDatabase()
  const transaction = database.transaction(storeName, "readwrite")
  await requestResult(transaction.objectStore(storeName).delete(id))
}

export async function clearPersonalDatabase(): Promise<void> {
  const database = await openPersonalDatabase()
  const transaction = database.transaction([...PERSONAL_STORES], "readwrite")
  await Promise.all(
    PERSONAL_STORES.map((store) => requestResult(transaction.objectStore(store).clear())),
  )
}

export async function exportPersonalDatabaseRecovery(): Promise<Record<string, unknown[]>> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(PERSONAL_DATABASE_NAME)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("Recovery storage is unavailable"))
    request.onblocked = () => reject(new Error("Close other RekeyZero Admin pages and try again"))
  })
  try {
    const available = PERSONAL_STORES.filter((store) => database.objectStoreNames.contains(store))
    if (!available.length) return {}
    const transaction = database.transaction(available, "readonly")
    return Object.fromEntries(await Promise.all(available.map(async (store) => [
      store,
      await requestResult(transaction.objectStore(store).getAll()) as unknown[],
    ])))
  } finally {
    database.close()
  }
}
