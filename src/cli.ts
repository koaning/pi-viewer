#!/usr/bin/env node
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { version } from "../package.json"
import type { CatalogModel } from "./api"
import { open } from "./open"
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
      --shared       Run as the server pi's --viewer flag shares: on a fixed port, without
                     opening the browser, until the last pi holding it is gone
  -h, --help         Show this
`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: "string", short: "p" },
    host: { type: "string" },
    dir: { type: "string" },
    "no-open": { type: "boolean" },
    shared: { type: "boolean" },
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

const shared = values.shared === true

// In shared mode the server lives as long as some pi holds it, plus a grace period for a pi that's reloading.
let holders = 0
let idle: ReturnType<typeof setTimeout> | undefined
const quitIn = (ms: number) => {
  if (idle) clearTimeout(idle)
  idle = setTimeout(() => quit(), ms)
}
const onHold = (delta: 1 | -1) => {
  holders += delta
  if (holders === 0) quitIn(5_000)
  else if (idle) {
    clearTimeout(idle)
    idle = undefined
  }
}

const app = createApp({
  version,
  onHold: shared ? onHold : undefined,
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

const listen = (port: number, tries = 10) => {
  app.once("error", (error: NodeJS.ErrnoException) => {
    // Another pi started the shared server first.
    if (error.code === "EADDRINUSE" && shared) process.exit(0)
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
    if (!values["no-open"] && !shared && client) open(url)
    // A pi that spawned this and died before holding it.
    if (shared && holders === 0) quitIn(30_000)
  })
}

listen(values.port ? Number(values.port) : 4545)

function quit() {
  index.stop()
  app.close()
  process.exit(0)
}
process.on("SIGINT", quit)
process.on("SIGTERM", quit)
