/**
 * The pi extension: `pi --viewer` (or `/viewer` in a session) opens the dashboard.
 *
 * Every pi shares one server on a fixed port. The first to need it spawns `cli.js --shared`, detached; the rest find it
 * through /api/hello. Each pi holds an open /api/hold request, which the OS closes when pi exits, however it exits; the
 * server quits a few seconds after the last one goes.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { get, type ClientRequest } from "node:http"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { open } from "./open"
import { idOf } from "./server/sessions"

const port = Number(process.env.PI_VIEWER_PORT) || 4545
const base = `http://127.0.0.1:${port}`
const url = `http://localhost:${port}/`

// Kept on globalThis: pi rebuilds the extension on /new, /resume and /reload, and one hold per pi is enough.
const HOLD = Symbol.for("pi-viewer.hold")
const store = globalThis as { [HOLD]?: ClientRequest }

const here = dirname(fileURLToPath(import.meta.url))
// Built: dist/extension.js next to dist/cli.js. From source: the build in dist/.
const cli = () => [join(here, "cli.js"), join(here, "..", "dist", "cli.js")].find(existsSync)

/** What answers on the port: our server, something else, or nothing. */
const probe = async (): Promise<"pi-viewer" | "other" | "none"> => {
  try {
    const res = await fetch(`${base}/api/hello`, { signal: AbortSignal.timeout(500) })
    const body = (await res.json().catch(() => undefined)) as { app?: string } | undefined
    return body?.app === "pi-viewer" ? "pi-viewer" : "other"
  } catch (error) {
    // A refused connection means nothing listens; a timeout means something does, but not us.
    return (error as Error).name === "TimeoutError" ? "other" : "none"
  }
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

/** Makes sure the shared server runs, starting it if need be. Returns an error to show, if it couldn't. */
const ensure = async (): Promise<string | undefined> => {
  let found = await probe()
  if (found === "other") return `port ${port} is taken by something else (set PI_VIEWER_PORT to use another)`
  if (found === "pi-viewer") return
  const path = cli()
  if (!path) return "dist/cli.js is missing; run `bun run build`"
  spawn(process.execPath, [path, "--shared", "--port", String(port)], { detached: true, stdio: "ignore" }).unref()
  for (let i = 0; i < 50 && found !== "pi-viewer"; i++) {
    await sleep(100)
    found = await probe()
  }
  return found === "pi-viewer" ? undefined : "the server didn't start"
}

/** Holds the server open for as long as this pi runs. */
const hold = () => {
  if (store[HOLD]) return
  const req = get(`${base}/api/hold`, (res) => res.resume())
  // Connected, but not what keeps pi from exiting.
  req.on("socket", (socket) => socket.unref())
  const drop = () => {
    if (store[HOLD] === req) delete store[HOLD]
  }
  req.on("close", drop)
  req.on("error", drop)
  store[HOLD] = req
}

/** This session's page; the dashboard waits there if pi hasn't written the file yet. The list for --no-session. */
const pageOf = (ctx: ExtensionContext) => {
  const file = ctx.sessionManager.getSessionFile()
  return file ? `${url}#/s/${encodeURIComponent(idOf(file))}` : url
}

const viewer = async (ctx: ExtensionContext, page: string) => {
  const error = await ensure()
  if (error) return ctx.ui.notify(`pi-viewer: ${error}`, "error")
  hold()
  open(page)
  ctx.ui.notify(`pi-viewer: ${page}`, "info")
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag("viewer", { type: "boolean", default: false, description: "Open the pi-viewer dashboard of every session" })

  pi.on("session_start", (event, ctx) => {
    if (event.reason === "startup" && pi.getFlag("viewer")) void viewer(ctx, url)
  })

  pi.registerCommand("viewer", {
    description: "Open this session in the pi-viewer dashboard",
    handler: (_args, ctx) => viewer(ctx, pageOf(ctx)),
  })
}
