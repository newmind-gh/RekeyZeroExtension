import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import process from "node:process"

const root = resolve(import.meta.dirname, "..")
const build = {
  localAiFamily: "local",
  webLlmVersion: "0.2.82",
  outputName: "rekeyzero-personal",
}
const buildArguments = process.argv.slice(2)

const repositoryRoot = resolve(root, "..", "..")
const destination = process.env.REKEYZERO_EXTENSION_OUTPUT_DIRECTORY
  ? resolve(process.env.REKEYZERO_EXTENSION_OUTPUT_DIRECTORY)
  : join(repositoryRoot, "dist", build.outputName)
const staging = mkdtempSync(join(tmpdir(), "rekeyzero-personal-build-"))
const node = process.execPath
const webLlmPackageRoot = resolveWebLlmPackageRoot(build.webLlmVersion)
const environment = {
  ...process.env,
  REKEYZERO_EXTENSION_OUTPUT_DIRECTORY: staging,
  REKEYZERO_LOCAL_AI_FAMILY: build.localAiFamily,
  REKEYZERO_WEBLLM_VERSION: build.webLlmVersion,
  REKEYZERO_WEBLLM_RUNTIME_ENTRY: join(webLlmPackageRoot, "lib", "index.js"),
}

process.stdout.write(`Building Personal: browser-local AI with WebLLM ${build.webLlmVersion}\n`)

try {
  execFileSync(node, [join(root, "node_modules", "typescript", "bin", "tsc"), "-b", ...buildArguments], {
    cwd: root,
    env: environment,
    stdio: "inherit",
  })
  execFileSync(node, [join(root, "node_modules", "vite", "bin", "vite.js"), "build", "--mode", "personal"], {
    cwd: root,
    env: environment,
    stdio: "inherit",
  })
  execFileSync(node, [join(root, "node_modules", "vite", "bin", "vite.js"), "build", "--mode", "personal", "--config", "vite.content.config.ts"], {
    cwd: root,
    env: environment,
    stdio: "inherit",
  })

  labelPersonalBuild(staging, build.localAiFamily)

  mkdirSync(destination, { recursive: true })
  cpSync(staging, destination, { recursive: true, force: true })
  removeStaleEntries(staging, destination)
  process.stdout.write(`Updated stable extension directory: ${destination}\n`)
} finally {
  rmSync(staging, { recursive: true, force: true })
}

function resolveWebLlmPackageRoot(expectedVersion) {
  const packageRoot = join(root, "node_modules", "@mlc-ai", "web-llm")
  const actualVersion = installedPackageVersion(packageRoot)
  if (actualVersion !== expectedVersion) {
    throw new Error(
      `Expected @mlc-ai/web-llm ${expectedVersion} in apps/extension/node_modules but found ${actualVersion ?? "nothing"}. Run npm install.`,
    )
  }
  return packageRoot
}

function installedPackageVersion(packageRoot) {
  const packageJson = join(packageRoot, "package.json")
  if (!existsSync(packageJson)) return null
  return JSON.parse(readFileSync(packageJson, "utf8")).version ?? null
}

function labelPersonalBuild(outputDirectory, family) {
  const sidepanel = join(outputDirectory, "sidepanel.html")
  if (!existsSync(sidepanel)) return
  const html = readFileSync(sidepanel, "utf8")
  writeFileSync(sidepanel, html.replace("<body>", `<body data-local-ai-family="${family}">`))
}

function removeStaleEntries(source, target) {
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name)
    const targetPath = join(target, entry.name)
    if (!existsSync(sourcePath)) {
      rmSync(targetPath, { recursive: true, force: true })
      continue
    }
    if (entry.isDirectory()) removeStaleEntries(sourcePath, targetPath)
  }
}
