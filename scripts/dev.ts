import { spawn } from "node:child_process"

// Development: the API from source on :4546 (restarting on change), and Vite with HMR on :5173 proxying /api to it.
// Extra arguments go to the CLI, e.g. `bun run dev -- --dir /tmp/sessions`, except --open, which has Vite open its page
// once it's ready.
const args = process.argv.slice(2)
const api = spawn("bun", ["--watch", "src/cli.ts", "--no-open", "--port", "4546", ...args.filter((a) => a !== "--open")], { stdio: "inherit" })
const vite = spawn("bunx", ["vite", ...(args.includes("--open") ? ["--open"] : [])], { stdio: "inherit", env: { ...process.env, DEV_API_PORT: "4546" } })
const stop = () => {
  api.kill()
  vite.kill()
  process.exit(0)
}
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
api.on("exit", stop)
vite.on("exit", stop)
