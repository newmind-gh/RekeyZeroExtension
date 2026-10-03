import "fake-indexeddb/auto"

import { describe, expect, it } from "vitest"

import { PERSONAL_STORES } from "./schema"
import {
  createPersonalDatabaseOpener,
  openVersionedPersonalDatabase,
  PERSONAL_DATABASE_VERSION,
} from "./indexed-db"

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

describe("Personal IndexedDB schema", () => {
  it("opens only the current Personal stores", async () => {
    const name = `rekeyzero-current-${crypto.randomUUID()}`
    const database = await openVersionedPersonalDatabase(name)

    expect(database.version).toBe(PERSONAL_DATABASE_VERSION)
    expect([...database.objectStoreNames].sort()).toEqual([...PERSONAL_STORES].sort())
    for (const store of [
      "destinations",
      "mappings",
      "browser_tasks",
      "actions",
      "executions",
      "events",
      "transfer_mappings",
      "transfer_target_groups",
    ]) expect(database.objectStoreNames.contains(store)).toBe(false)

    database.close()
    await requestResult(indexedDB.deleteDatabase(name))
  })

  it("drops retired stores when the schema version changes", async () => {
    const name = `rekeyzero-retired-${crypto.randomUUID()}`
    const legacyRequest = indexedDB.open(name, PERSONAL_DATABASE_VERSION - 1)
    legacyRequest.onupgradeneeded = () => {
      for (const store of PERSONAL_STORES) {
        legacyRequest.result.createObjectStore(store, { keyPath: "id" })
      }
      for (const store of ["records", "revisions", "evidence", "provider_configs", "destinations", "mappings", "browser_tasks", "actions", "executions", "events"]) {
        legacyRequest.result.createObjectStore(store, { keyPath: "id" })
      }
    }
    const legacy = await requestResult(legacyRequest)
    const profile = { id: "preserved-profile", name: "Preserved fixture" }
    const transaction = legacy.transaction(["transfer_mapping_profiles", "records", "settings"], "readwrite")
    await Promise.all([
      requestResult(transaction.objectStore("transfer_mapping_profiles").put(profile)),
      requestResult(transaction.objectStore("records").put({ id: "retired-record", information: "PRIVATE_OLD_VALUE" })),
      requestResult(transaction.objectStore("settings").put({ id: "personal", localModelEnabled: true, localModelId: "personal-qwen25-15b-v1" })),
    ])
    legacy.close()

    const current = await openVersionedPersonalDatabase(name)
    expect([...current.objectStoreNames].sort()).toEqual([...PERSONAL_STORES].sort())
    expect(await requestResult(current.transaction("transfer_mapping_profiles").objectStore("transfer_mapping_profiles").get(profile.id))).toEqual(profile)
    expect(await requestResult(current.transaction("settings").objectStore("settings").get("personal"))).toMatchObject({ localModelEnabled: true })
    current.close()
    await requestResult(indexedDB.deleteDatabase(name))
  })

  it("retries after a blocked open", async () => {
    const name = `rekeyzero-blocked-${crypto.randomUUID()}`
    const request = indexedDB.open(name, PERSONAL_DATABASE_VERSION - 1)
    request.onupgradeneeded = () => {
      for (const store of PERSONAL_STORES) request.result.createObjectStore(store, { keyPath: "id" })
    }
    const blocker = await requestResult(request)
    const openDatabase = createPersonalDatabaseOpener(name)

    await expect(openDatabase()).rejects.toThrow("upgrade is blocked")
    blocker.close()

    const recovered = await openDatabase()
    expect(recovered.version).toBe(PERSONAL_DATABASE_VERSION)
    recovered.close()
    await requestResult(indexedDB.deleteDatabase(name))
  })
})
