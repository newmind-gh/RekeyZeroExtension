import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import process from "node:process"

import {
  dependencyInventory,
  detectSecrets,
  mergeDistributedDependencyInventories,
} from "./release-support.mjs"

const root = resolve(import.meta.dirname, "..")
const profile = "personal"
if (process.argv.length > 2) {
  throw new Error("Release packaging does not accept dirty-build overrides")
}

const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
const manifestSource = JSON.parse(
  readFileSync(join(root, `manifest.${profile}.json`), "utf8"),
)
if (packageJson.version !== manifestSource.version) throw new Error("Package and extension versions must match")
const commit = execFileSync("git", ["-c", `safe.directory=${resolve(root, "..", "..").replaceAll("\\", "/")}`, "rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim()
const workingTreeStatus = execFileSync(
  "git",
  ["-c", `safe.directory=${resolve(root, "..", "..").replaceAll("\\", "/")}`, "status", "--porcelain"],
  { cwd: root, encoding: "utf8" },
).trim()
const shortCommit = commit.slice(0, 12)
const version = manifestSource.version
const repositoryRoot = resolve(root, "..", "..")
const sourceSnapshotSha256 = hashSourceSnapshot(repositoryRoot)
const sourceState = workingTreeStatus ? "snapshot" : "clean"
const sourceIdentity = sourceState === "clean" ? shortCommit : `snapshot.${sourceSnapshotSha256.slice(0, 12)}`
const artifactName = `rekeyzero-${profile}`
const releaseRoot = resolve(root, "..", "..", "dist")
const staging = join(releaseRoot, artifactName)
const zipPath = join(releaseRoot, `${artifactName}.zip`)

const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error("Run this release command through npm")
execFileSync(process.execPath, [npmCli, "run", "build"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, REKEYZERO_EXTENSION_OUTPUT_DIRECTORY: staging },
})

const files = listFiles(staging)
const remoteReferences = scanRemoteReferences(files)
const remoteExecutableReferences = remoteReferences.filter(({ url }) => /\.(?:js|mjs|wasm)(?:[?#]|$)/i.test(url))
const secretFindings = scanSecrets(files)
runDedicatedSecretScan(files)
const lockfile = readFileSync(join(root, "package-lock.json"))
const inventory = dependencyInventory(JSON.parse(lockfile.toString("utf8")))
const buildMetadataRoot = resolve(root, "..", "..", "artifacts", "extension-build-metadata")
const distributedInventory = mergeDistributedDependencyInventories([
  JSON.parse(readFileSync(join(buildMetadataRoot, `${profile}-application.json`), "utf8")),
  JSON.parse(readFileSync(join(buildMetadataRoot, `${profile}-content-script.json`), "utf8")),
])
const report = {
  schema_version: 1,
  product_profile: profile,
  semantic_version: version,
  git_commit: commit,
  source_state: sourceState,
  source_snapshot_sha256: sourceSnapshotSha256,
  build_timestamp: new Date().toISOString(),
  node_version: process.version,
  npm_version: execFileSync(process.execPath, [npmCli, "--version"], { encoding: "utf8" }).trim(),
  package_lock_sha256: sha256(lockfile),
  manifest_permissions: {
    permissions: manifestSource.permissions ?? [],
    host_permissions: manifestSource.host_permissions ?? [],
    optional_host_permissions: manifestSource.optional_host_permissions ?? [],
  },
  files: files.map((file) => ({
    path: relative(staging, file).replaceAll("\\", "/"),
    size: statSync(file).size,
    sha256: sha256(readFileSync(file)),
  })),
  lockfile_dependency_inventory: inventory,
  distributed_dependency_inventory: distributedInventory,
  remote_references: remoteReferences,
  remote_executable_references: remoteExecutableReferences,
  secret_findings: secretFindings,
  dedicated_secret_scan: "secretlint/@secretlint/secretlint-rule-preset-recommend",
  chrome_web_store_remote_hosted_code_gate:
    remoteExecutableReferences.length === 0 ? "pass-static-scan" : "blocked",
}
writeFileSync(join(staging, "release-manifest.json"), `${JSON.stringify(report, null, 2)}\n`)

if (secretFindings.length) {
  throw new Error(`Release secret scan failed: ${secretFindings.length} finding(s)`)
}
if (remoteExecutableReferences.length) {
  throw new Error(
    `Remote-hosted executable scan failed: ${remoteExecutableReferences.map(({ url }) => url).join(", ")}`,
  )
}

writeStoredZip(staging, zipPath)
const packageSha256 = sha256(readFileSync(zipPath))
writeFileSync(
  join(releaseRoot, `${artifactName}.manifest.json`),
  `${JSON.stringify({ ...report, package_sha256: packageSha256 }, null, 2)}\n`,
)
writeFileSync(join(releaseRoot, `${artifactName}.sha256`), `${packageSha256}  ${artifactName}.zip\n`)
process.stdout.write(`${zipPath}\nSHA-256 ${packageSha256}\n`)

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

function hashSourceSnapshot(repositoryDirectory) {
  const safeRepositoryDirectory = repositoryDirectory.replaceAll("\\", "/")
  const paths = execFileSync("git", [
    "-c",
    `safe.directory=${safeRepositoryDirectory}`,
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ], { cwd: repositoryDirectory, encoding: "utf8" }).split("\0").filter(Boolean).sort()
  const hash = createHash("sha256")
  for (const path of paths) {
    const absolutePath = resolve(repositoryDirectory, path)
    hash.update(path).update("\0")
    hash.update(existsSync(absolutePath) ? readFileSync(absolutePath) : Buffer.from("<deleted>"))
    hash.update("\0")
  }
  return hash.digest("hex")
}

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? listFiles(path) : [path]
  }).sort()
}

function scanRemoteReferences(filesToScan) {
  const results = []
  const pattern = /https?:\/\/[^\s"'`<>\\)]+/g
  for (const file of filesToScan.filter((path) => /\.(?:js|json|html|css)$/i.test(path))) {
    const content = readFileSync(file, "utf8")
    for (const match of content.matchAll(pattern)) {
      results.push({ file: relative(staging, file).replaceAll("\\", "/"), url: match[0] })
    }
  }
  return results
}

function scanSecrets(filesToScan) {
  return filesToScan.flatMap((file) => {
    const content = readFileSync(file)
    if (content.includes(0)) return []
    return detectSecrets(content.toString("utf8")).map(({ id, offset }) => ({
      file: relative(staging, file).replaceAll("\\", "/"),
      detector: id,
      offset,
    }))
  })
}

function runDedicatedSecretScan(filesToScan) {
  const textFiles = filesToScan.filter((path) => /\.(?:css|html|js|json|map|txt)$/i.test(path))
  if (!textFiles.length) return
  execFileSync(process.execPath, [
    join(root, "node_modules", "secretlint", "bin", "secretlint.js"),
    "--no-color",
    "--secretlintrc",
    join(root, ".secretlintrc.json"),
    ...textFiles.map((path) => relative(staging, path)),
  ], { cwd: staging, stdio: "inherit" })
}

function crc32(buffer) {
  const table = Array.from({ length: 256 }, (_, index) => {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
    return value >>> 0
  })
  let crc = 0xffffffff
  for (const byte of buffer) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff]
  return (crc ^ 0xffffffff) >>> 0
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear())
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  }
}

function writeStoredZip(sourceDirectory, destination) {
  const entries = listFiles(sourceDirectory).map((path) => ({
    name: relative(sourceDirectory, path).replaceAll("\\", "/"),
    data: readFileSync(path),
    modified: statSync(path).mtime,
  }))
  const localParts = []
  const centralParts = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const checksum = crc32(entry.data)
    const stamp = dosDateTime(entry.modified)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(stamp.time, 10)
    local.writeUInt16LE(stamp.date, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(entry.data.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    localParts.push(local, name, entry.data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(stamp.time, 12)
    central.writeUInt16LE(stamp.date, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(entry.data.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)
    offset += local.length + name.length + entry.data.length
  }
  const centralSize = centralParts.reduce((size, part) => size + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, Buffer.concat([...localParts, ...centralParts, end]))
}
