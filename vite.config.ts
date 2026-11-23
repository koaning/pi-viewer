import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

// The browser half: built into dist/client, which the CLI serves. `bun run dev` serves it with HMR and proxies /api
// to a CLI started on DEV_API_PORT.
export default defineConfig({
  root: fileURLToPath(new URL("./src/client", import.meta.url)),
  plugins: [solid()],
  build: { outDir: fileURLToPath(new URL("./dist/client", import.meta.url)), emptyOutDir: true },
  server: { proxy: { "/api": `http://127.0.0.1:${process.env.DEV_API_PORT ?? 4546}` } },
})
