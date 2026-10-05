import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

import { extensionOutputDirectory } from "./build-output"
import { distributedDependencyMetadata } from "./vite.distributed-metadata"

export default defineConfig(() => {
  const outputDirectory = extensionOutputDirectory()
  const localAiFamily = process.env.REKEYZERO_LOCAL_AI_FAMILY || "local"
  const webLlmRuntimeEntry = process.env.REKEYZERO_WEBLLM_RUNTIME_ENTRY
  return {
    define: {
      __REKEYZERO_LOCAL_AI_FAMILY__: JSON.stringify(localAiFamily),
    },
    resolve: {
      alias: [
        ...(webLlmRuntimeEntry ? [{ find: "@mlc-ai/web-llm", replacement: webLlmRuntimeEntry }] : []),
        { find: /^onnxruntime-web(?:\/webgpu)?$/, replacement: resolve(import.meta.dirname, "node_modules/onnxruntime-web/dist/ort.wasm.min.mjs") },
      ],
    },
    ssr: {
      noExternal: ["@mlc-ai/web-llm"],
    },
    plugins: [
      react(),
      distributedDependencyMetadata("application"),
      {
        name: "copy-extension-manifest",
        closeBundle() {
          mkdirSync(outputDirectory, { recursive: true })
          copyFileSync(
            resolve(import.meta.dirname, "manifest.personal.json"),
            resolve(outputDirectory, "manifest.json"),
          )
          const privacyRuntime = resolve(outputDirectory, "privacy-runtime")
          mkdirSync(privacyRuntime, { recursive: true })
          for (const filename of ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"]) {
            copyFileSync(resolve(import.meta.dirname, "node_modules/onnxruntime-web/dist", filename), resolve(privacyRuntime, filename))
          }
          const metadataPath = resolve(import.meta.dirname, "../../artifacts/extension-build-metadata/personal-privacy-worker.json")
          const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Array<{ package_name: string; bundled_files: string[] }>
          const runtime = metadata.find((entry) => entry.package_name === "onnxruntime-web")!
          runtime.bundled_files = [...new Set([...runtime.bundled_files,
            "privacy-runtime/ort-wasm-simd-threaded.mjs", "privacy-runtime/ort-wasm-simd-threaded.wasm"])].sort()
          writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`)
        },
      },
    ],
    worker: {
      format: "es",
      plugins: () => [
        {
          name: "omit-doccloak-rule-examples",
          transform(code, id) {
            if (!id.replaceAll("\\", "/").endsWith("/node_modules/@doccloak/core/dist/regex/rules.data.js")) return
            // Upstream sample credentials are documentation, not detector data.
            // Omit them from production without weakening release secret scans.
            const prefix = "export const RULES_DATA = "
            if (!code.startsWith(prefix)) throw new Error("Unexpected DocCloak rules module")
            const packs = JSON.parse(code.slice(prefix.length).trim().replace(/;$/, "")) as Array<{ rules: Array<{ examples?: string[] }> }>
            for (const pack of packs) for (const rule of pack.rules) delete rule.examples
            return { code: `${prefix}${JSON.stringify(packs)};`, map: null }
          },
        },
        distributedDependencyMetadata("privacy-worker"),
      ],
      rollupOptions: {
        // Unused document/DOM re-exports must not pull DocCloak's converters
        // into the privacy worker. Retain every referenced engine module.
        treeshake: { moduleSideEffects: (id) => !id.replaceAll("\\", "/").includes("/node_modules/@doccloak/core/") },
      },
    },
    build: {
      outDir: outputDirectory,
      emptyOutDir: true,
      rollupOptions: {
        input: {
          sidepanel: resolve(import.meta.dirname, "sidepanel.html"),
          "service-worker": resolve(import.meta.dirname, "src/background/service-worker.ts"),
          rekeyzero: resolve(import.meta.dirname, "rekeyzero.html"),
        },
        output: {
          entryFileNames: "[name].js",
          chunkFileNames: "assets/[name]-[hash].js",
          assetFileNames: "assets/[name]-[hash][extname]",
        },
      },
    },
  }
})
