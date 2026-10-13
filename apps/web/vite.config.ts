import { svelte } from "@sveltejs/vite-plugin-svelte"
import { defineConfig } from "vite"

const API_TARGET = process.env.API_TARGET ?? "http://127.0.0.1:3000"

export default defineConfig({
  plugins: [
    svelte(),
    // Must come after svelte() so the DOM build wins for test files only.
    // Without it Vitest resolves Svelte's SSR entry, and every component mount
    // dies with lifecycle_function_unavailable because $effect does not exist
    // on the server.
    {
      name: "vitest-dom-condition",
      apply: "serve",
      config: () => ({ resolve: { conditions: ["browser"] } }),
    } satisfies import("vite").Plugin,
  ],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
  },
  server: {
    port: 5173,
    // Bind loopback only. The dev server has no authentication of its own, so it
    // must never be reachable from the LAN — that is the whole point of the
    // gateway.
    host: "127.0.0.1",
    proxy: {
      // Same-origin API in development too, so the client never has to know
      // whether it is talking to Vite or to Nest. The session cookie is
      // host-only, so a cross-origin dev setup would not carry it anyway.
      "/api": {
        target: API_TARGET,
        changeOrigin: false,
        // SSE must not be buffered by the dev proxy.
        ws: false,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    // The gateway serves this from disk; a predictable layout keeps the Docker
    // copy step trivial.
    assetsDir: "assets",
  },
})