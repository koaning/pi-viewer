import { existsSync, readFileSync, statSync } from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { extname, join, normalize, sep } from "node:path"
import type { CatalogModel } from "../api"
import type { SessionIndex } from "./watch"

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
}

const json = (res: ServerResponse, value: unknown, status = 200) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
  res.end(JSON.stringify(value))
}

/** Opens a server-sent event stream; returns a function that sends one event. */
const stream = (req: IncomingMessage, res: ServerResponse, onClose: () => void) => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" })
  res.write(": hi\n\n")
  // Keeps proxies and the browser from timing out an idle stream.
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000)
  req.on("close", () => {
    clearInterval(ping)
    onClose()
  })
  return (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`)
}

export interface Options {
  readonly index: SessionIndex
  readonly catalog: () => Promise<readonly CatalogModel[]>
  /** The built client, or undefined to serve only the API (in development, Vite serves the page). */
  readonly client?: string
  /**
   * Host names the server answers to. Transcripts hold code and secrets, so a page on another site that points its
   * own name at 127.0.0.1 (DNS rebinding) must not get them. Undefined allows any, for --host on a trusted network.
   */
  readonly hosts?: ReadonlySet<string>
}

const hostname = (header: string | undefined) => {
  if (!header) return ""
  if (header.startsWith("[")) return header.slice(0, header.indexOf("]") + 1)
  return header.split(":")[0]!
}

export function createApp(options: Options): Server {
  const { index } = options

  const serveStatic = (res: ServerResponse, pathname: string) => {
    const root = options.client
    if (!root || !existsSync(root)) {
      res.writeHead(404, { "content-type": "text/plain" })
      return res.end("The client isn't built. Run `bun run build`, or `bun run dev` for development.")
    }
    const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "")
    let path = join(root, rel)
    if (!path.startsWith(root + sep) && path !== root) return json(res, { error: "not found" }, 404)
    if (!existsSync(path) || statSync(path).isDirectory()) path = join(root, "index.html")
    res.writeHead(200, {
      "content-type": TYPES[extname(path)] ?? "application/octet-stream",
      "cache-control": path.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache",
    })
    res.end(readFileSync(path))
  }

  return createServer(async (req, res) => {
    if (options.hosts && !options.hosts.has(hostname(req.headers.host).toLowerCase())) {
      res.writeHead(403, { "content-type": "text/plain" })
      return res.end("pi-viewer only answers to localhost.")
    }
    const url = new URL(req.url ?? "/", "http://localhost")
    const path = url.pathname
    try {
      if (path === "/api/sessions") return json(res, index.list())
      if (path === "/api/sessions/stream") {
        const send = stream(req, res, () => off())
        const off = index.onList((list) => send({ type: "sessions", sessions: list }))
        send({ type: "sessions", sessions: index.list() })
        return
      }
      if (path === "/api/models") return json(res, await options.catalog())
      const match = /^\/api\/sessions\/([^/]+)(\/stream)?$/.exec(path)
      if (match) {
        const file = index.get(decodeURIComponent(match[1]!))
        if (!file) return json(res, { error: "no such session" }, 404)
        if (!match[2]) return json(res, file.load())
        let off = () => {}
        const send = stream(req, res, () => off())
        off = file.subscribe(send)
        return
      }
      if (path.startsWith("/api/")) return json(res, { error: "not found" }, 404)
      if (req.method !== "GET" && req.method !== "HEAD") return json(res, { error: "method not allowed" }, 405)
      return serveStatic(res, path)
    } catch (error) {
      if (!res.headersSent) json(res, { error: String(error) }, 500)
      else res.end()
    }
  })
}
