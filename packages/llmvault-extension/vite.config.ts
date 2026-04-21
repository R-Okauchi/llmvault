import { defineConfig, type Plugin } from "vite";
import preact from "@preact/preset-vite";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const browserTarget = process.env.BROWSER_TARGET ?? "chrome";
const outDir = browserTarget === "firefox" ? "dist-firefox" : "dist-chrome";

/**
 * Post-build plugin that copies manifest.json to the output dir and merges
 * the Firefox overlay when BROWSER_TARGET=firefox.
 */
function manifestPlugin(): Plugin {
  return {
    name: "llmvault-manifest",
    closeBundle() {
      const base = JSON.parse(readFileSync(resolve(__dirname, "public/manifest.json"), "utf-8"));

      if (browserTarget === "firefox") {
        const overlay = JSON.parse(
          readFileSync(resolve(__dirname, "public/manifest.firefox.json"), "utf-8"),
        );
        // Deep-merge: overlay wins. Only top-level keys are merged.
        Object.assign(base, overlay);
      }

      writeFileSync(resolve(__dirname, outDir, "manifest.json"), JSON.stringify(base, null, 2));

      // Remove the Firefox overlay copy that Vite places in output from public/
      try {
        unlinkSync(resolve(__dirname, outDir, "manifest.firefox.json"));
      } catch {
        // File may not exist — ignore
      }
    },
  };
}

export default defineConfig({
  plugins: [preact(), manifestPlugin()],
  build: {
    outDir,
    emptyDir: true,
    rollupOptions: {
      input: {
        background: resolve(__dirname, "src/background/index.ts"),
        content: resolve(__dirname, "src/content/announce.ts"),
        popup: resolve(__dirname, "src/popup/index.html"),
        consent: resolve(__dirname, "src/consent/index.html"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
