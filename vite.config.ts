// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare as a default target),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import type { Plugin } from "vite";

import { createOfflineServiceWorkerSource } from "./src/lib/offline-service-worker.ts";

const OFFLINE_PUBLIC_FILES = [
  "/",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/templates/cut-master-pro-input-template.xlsx",
];

const offlineServiceWorker = (): Plugin => ({
  name: "cut-master-pro-offline-service-worker",
  apply: "build",
  applyToEnvironment: (environment) => environment.name === "client",
  generateBundle(_options, bundle) {
    const bundleUrls = Object.values(bundle).map((file) => `/${file.fileName}`);
    this.emitFile({
      type: "asset",
      fileName: "sw.js",
      source: createOfflineServiceWorkerSource([...OFFLINE_PUBLIC_FILES, ...bundleUrls]),
    });
  },
});

export default defineConfig({
  plugins: [offlineServiceWorker()],
  // Skip the Nitro/Cloudflare server bundle so the build is a static SPA.
  nitro: false,
  tanstackStart: {
    // Client-only runtime: no SSR after the static shell is prerendered.
    spa: {
      enabled: true,
      maskPath: "/",
      prerender: {
        // Capacitor looks for dist/client/index.html
        outputPath: "/index",
      },
    },
    prerender: {
      enabled: true,
    },
    pages: [{ path: "/" }],
  },
});
