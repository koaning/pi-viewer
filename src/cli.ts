#!/usr/bin/env node
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import type { CatalogModel } from "./api"
import { loadCatalog } from "./server/catalog"
import { createApp } from "./server/http"
import { agentDir, sessionsDir } from "./server/paths"
import { idOf } from "./server/sessions"
import { SessionIndex } from "./server/watch"

const HELP = `pi-viewer: a live dashboard of your pi sessions, in the browser

Usage: pi-viewer [session] [options]

  session            A session to open: its id (or the start of it), or its .jsonl file.
                     Without one, opens the list of every session.

Options:
  -p, --port <n>     Port to serve on (default 4545; the next free one if taken)
      --host <name>  Interface to listen on (default 127.0.0.1). Anything else
                     answers to any Host header; only use it on a network you trust.
      --dir <path>   pi's sessions directory (default $PI_CODING_AGENT_SESSION_DIR,
                     else $PI_CODING_AGENT_DIR/sessions, else ~/.pi/agent/sessions)
      --no-open      Don't open the browser
  -h, --help         Show this
`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: "string", short: "p" },
    host: { type: "string" },
    dir: { type: "string" },
    "no-open": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
})

if (values.help) {
  process.stdout.write(HELP)
  process.exit(0)
}

const dir = values.dir ? resolve(values.dir) : sessionsDir()
const host = values.host ?? "127.0.0.1"
const local = host === "127.0.0.1" || host === "localhost" || host === "::1"
const here = dirname(fileURLToPath(import.meta.url))
// Built: dist/cli.js next to dist/client. From source (bun src/cli.ts), the API only.
const client = [join(here, "client"), join(here, "..", "dist", "client")].find((path) => existsSync(join(path, "index.html")))

if (!existsSync(dir)) process.stderr.write(`pi-viewer: no sessions directory at ${dir} yet; watching for it.\n`)

const index = new SessionIndex(dir).start()

let catalog: { at: number; models: Promise<CatalogModel[]> } | undefined
const models = () => {
  // pi refreshes its catalog files now and then; a few minutes old is fine.
  if (!catalog || Date.now() - catalog.at > 5 * 60_000) catalog = { at: Date.now(), models: loadCatalog(agentDir()).catch(() => []) }
  return catalog.models
}
void models()

const app = createApp({
  index,
  catalog: models,
  client,
  hosts: local ? new Set(["localhost", "127.0.0.1", "[::1]"]) : undefined,
})

/** The session the argument names: a path, an id, or the start of one. */
const target = (arg: string | undefined) => {
  if (!arg) return undefined
  if (arg.endsWith(".jsonl")) return idOf(arg)
  const list = index.list()
  return (list.find((s) => s.id === arg) ?? list.find((s) => s.id.startsWith(arg)))?.id ?? arg
}

const open = (url: string) => {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]]
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => undefined).unref()
  } catch {
    // No browser to open; the URL is printed.
  }
}

const listen = (port: number, tries = 10) => {
  app.once("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE" && tries > 0 && !values.port) return listen(port + 1, tries - 1)
    process.stderr.write(`pi-viewer: ${error.message}\n`)
    process.exit(1)
  })
  app.listen(port, host, () => {
    const shown = host.includes(":") ? `[${host}]` : host === "127.0.0.1" ? "localhost" : host
    const id = target(positionals[0])
    const url = `http://${shown}:${port}/${id ? `#/s/${encodeURIComponent(id)}` : ""}`
    process.stdout.write(`pi-viewer: ${index.list().length} sessions in ${dir}\n  ${url}\n`)
    if (!client) process.stdout.write("  (API only: the client isn't built; `bun run dev` serves it)\n")
    if (!values["no-open"] && client) open(url)
  })
}

listen(values.port ? Number(values.port) : 4545)

const quit = () => {
  index.stop()
  app.close()
  process.exit(0)
}
process.on("SIGINT", quit)
process.on("SIGTERM", quit)
