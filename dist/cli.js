#!/usr/bin/env node

// src/cli.ts
import { existsSync as existsSync3 } from "node:fs";
import { dirname as dirname2, join as join6, resolve as resolve2 } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
// package.json
var version = "0.1.1";

// src/open.ts
import { spawn } from "node:child_process";
var open = (url) => {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {
      return;
    }).unref();
  } catch {}
};

// src/server/catalog.ts
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
var costsOf = (cost) => {
  if (!cost)
    return;
  const rate = (c) => ({
    input: c.input ?? 0,
    output: c.output ?? 0,
    cache: { read: c.cacheRead ?? 0, write: c.cacheWrite ?? 0 }
  });
  return [
    rate(cost),
    ...(cost.tiers ?? []).map((t) => ({ ...rate({ ...cost, ...t }), tier: { type: "context", size: t.inputTokensAbove } }))
  ];
};
var modelOf = (provider, m) => m.id ? { provider: m.provider ?? provider, id: m.id, name: m.name ?? m.id, contextWindow: m.contextWindow, cost: costsOf(m.cost) } : undefined;
var readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return;
  }
};
var PACKAGES = ["@earendil-works/pi-ai", "@mariozechner/pi-ai"];
var GENERATED = "dist/models.generated.js";
var findGenerated = (agentDir, env = process.env) => {
  const candidates = [];
  try {
    const version2 = readFileSync(join(agentDir, "install", "current-version"), "utf8").trim();
    for (const pkg of PACKAGES)
      candidates.push(join(agentDir, "install", "releases", version2, "node_modules", pkg, GENERATED));
  } catch {}
  for (const bin of (env.PATH ?? "").split(delimiter)) {
    const pi = join(bin, "pi");
    if (!existsSync(pi))
      continue;
    let dir;
    try {
      dir = dirname(realpathSync(pi));
    } catch {
      continue;
    }
    for (let i = 0;i < 8; i++, dir = dirname(dir)) {
      for (const pkg of PACKAGES) {
        candidates.push(join(dir, "node_modules", pkg, GENERATED));
        candidates.push(join(dir, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", pkg, GENERATED));
        candidates.push(join(dir, "node_modules", "@mariozechner", "pi-coding-agent", "node_modules", pkg, GENERATED));
      }
    }
    break;
  }
  return candidates.find((path) => existsSync(path));
};
async function loadCatalog(agentDir) {
  const models = new Map;
  const put = (m) => {
    if (!m)
      return;
    const key = `${m.provider}/${m.id}`;
    const before = models.get(key);
    models.set(key, { ...before, ...m, contextWindow: m.contextWindow ?? before?.contextWindow, cost: m.cost ?? before?.cost });
  };
  const generated = findGenerated(agentDir);
  if (generated) {
    try {
      const mod = await import(pathToFileURL(generated).href);
      const all = mod.MODELS ?? {};
      for (const [provider, list] of Object.entries(all))
        for (const m of Object.values(list ?? {}))
          put(modelOf(provider, m));
    } catch {}
  }
  const store = readJson(join(agentDir, "models-store.json"));
  if (store && typeof store === "object")
    for (const [provider, entry] of Object.entries(store))
      for (const m of Array.isArray(entry?.models) ? entry.models : [])
        put(modelOf(provider, m));
  const custom = readJson(join(agentDir, "models.json"));
  for (const [provider, entry] of Object.entries(custom?.providers ?? {}))
    for (const m of Array.isArray(entry?.models) ? entry.models : [])
      put(modelOf(provider, m));
  return [...models.values()];
}

// src/server/http.ts
import { existsSync as existsSync2, readFileSync as readFileSync2, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join as join2, normalize, sep } from "node:path";
var TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json"
};
var json = (res, value, status = 200) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
};
var stream = (req, res, onClose) => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  res.write(`: hi

`);
  const ping = setInterval(() => res.write(`: ping

`), 25000);
  req.on("close", () => {
    clearInterval(ping);
    onClose();
  });
  return (data) => res.write(`data: ${JSON.stringify(data)}

`);
};
var hostname = (header) => {
  if (!header)
    return "";
  if (header.startsWith("["))
    return header.slice(0, header.indexOf("]") + 1);
  return header.split(":")[0];
};
function createApp(options) {
  const { index } = options;
  const serveStatic = (res, pathname) => {
    const root = options.client;
    if (!root || !existsSync2(root)) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("The client isn't built. Run `bun run build`, or `bun run dev` for development.");
    }
    const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
    let path = join2(root, rel);
    if (!path.startsWith(root + sep) && path !== root)
      return json(res, { error: "not found" }, 404);
    if (!existsSync2(path) || statSync(path).isDirectory())
      path = join2(root, "index.html");
    res.writeHead(200, {
      "content-type": TYPES[extname(path)] ?? "application/octet-stream",
      "cache-control": path.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache"
    });
    res.end(readFileSync2(path));
  };
  return createServer(async (req, res) => {
    if (options.hosts && !options.hosts.has(hostname(req.headers.host).toLowerCase())) {
      res.writeHead(403, { "content-type": "text/plain" });
      return res.end("pi-viewer only answers to localhost.");
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    try {
      if (path === "/api/hello")
        return json(res, { app: "pi-viewer", version: options.version ?? "" });
      if (path === "/api/hold") {
        options.onHold?.(1);
        stream(req, res, () => options.onHold?.(-1));
        return;
      }
      if (path === "/api/sessions")
        return json(res, index.list());
      if (path === "/api/sessions/stream") {
        const send = stream(req, res, () => off());
        const off = index.onList((list) => send({ type: "sessions", sessions: list }));
        send({ type: "sessions", sessions: index.list() });
        return;
      }
      if (path === "/api/models")
        return json(res, await options.catalog());
      const match = /^\/api\/sessions\/([^/]+)(\/stream)?$/.exec(path);
      if (match) {
        const id = decodeURIComponent(match[1]);
        const file = index.get(id);
        if (!match[2])
          return file ? json(res, file.load()) : json(res, { error: "no such session" }, 404);
        let off = () => {};
        const send = stream(req, res, () => off());
        if (file)
          off = file.subscribe(send);
        else {
          send({ type: "waiting" });
          off = index.onList(() => {
            const found = index.get(id);
            if (!found)
              return;
            off();
            off = found.subscribe(send);
          });
        }
        return;
      }
      if (path.startsWith("/api/"))
        return json(res, { error: "not found" }, 404);
      if (req.method !== "GET" && req.method !== "HEAD")
        return json(res, { error: "method not allowed" }, 405);
      return serveStatic(res, path);
    } catch (error) {
      if (!res.headersSent)
        json(res, { error: String(error) }, 500);
      else
        res.end();
    }
  });
}

// src/server/paths.ts
import { homedir } from "node:os";
import { join as join3, resolve } from "node:path";
var expand = (path) => path === "~" || path.startsWith("~/") ? join3(homedir(), path.slice(1)) : path;
var agentDir = (env = process.env) => resolve(expand(env.PI_CODING_AGENT_DIR || join3(homedir(), ".pi", "agent")));
var sessionsDir = (env = process.env) => resolve(expand(env.PI_CODING_AGENT_SESSION_DIR || join3(agentDir(env), "sessions")));

// src/server/sessions.ts
import { readdirSync, statSync as statSync2 } from "node:fs";
import { basename, join as join4 } from "node:path";

// src/api.ts
var LIVE_MS = 15 * 60000;
var RUNNING_MS = 10 * 60000;

// src/format.ts
var stripBlocks = (text) => {
  let out = text;
  for (let i = 0;i < 5; i++) {
    const next = out.replace(/<([A-Za-z][\w-]*)(\s[^>]*)?>([\s\S]*?)<\/\1>/g, (block, tag, attrs, inner) => {
      if (!inner.includes(`
`))
        return block;
      const skill = tag === "skill" && /\bname="([^"]+)"/.exec(attrs ?? "")?.[1];
      return skill ? ` /${skill} ` : " ";
    });
    if (next === out)
      break;
    out = next;
  }
  return out;
};

// src/pi/normalize.ts
var textOf = (content) => {
  if (typeof content === "string")
    return content;
  return (content ?? []).map((c) => c.type === "text" ? c.text : "").join("");
};

// src/server/tail.ts
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
var NEWLINE = 10;
var CHUNK = 1 << 20;

class LineReader {
  path;
  offset = 0;
  rest = Buffer.alloc(0);
  ino;
  constructor(path) {
    this.path = path;
  }
  read() {
    let fd;
    try {
      fd = openSync(this.path, "r");
    } catch {
      return { lines: [], reset: false };
    }
    try {
      const stat = fstatSync(fd);
      let reset = false;
      if (stat.size < this.offset || this.ino !== undefined && stat.ino !== this.ino) {
        this.offset = 0;
        this.rest = Buffer.alloc(0);
        reset = true;
      }
      this.ino = stat.ino;
      const lines = [];
      while (this.offset < stat.size) {
        const buffer = Buffer.alloc(Math.min(CHUNK, stat.size - this.offset));
        const n = readSync(fd, buffer, 0, buffer.length, this.offset);
        if (n <= 0)
          break;
        this.offset += n;
        let data = this.rest.length ? Buffer.concat([this.rest, buffer.subarray(0, n)]) : buffer.subarray(0, n);
        let start = 0;
        for (let i = data.indexOf(NEWLINE);i !== -1; i = data.indexOf(NEWLINE, start)) {
          const line = data.subarray(start, i).toString("utf8").trim();
          if (line)
            lines.push(line);
          start = i + 1;
        }
        this.rest = Buffer.from(data.subarray(start));
        data = Buffer.alloc(0);
      }
      return { lines, reset };
    } finally {
      closeSync(fd);
    }
  }
  get position() {
    return this.offset - this.rest.length;
  }
}
var stripImages = (content) => {
  if (!Array.isArray(content))
    return content;
  return content.map((c) => c && typeof c === "object" && c.type === "image" ? { type: "image", mimeType: c.mimeType } : c);
};
var parseLine = (line) => {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return;
  }
  if (!value || typeof value !== "object" || typeof value.type !== "string")
    return;
  if (value.type === "message" && value.message && typeof value.message === "object") {
    value.message.content = stripImages(value.message.content);
  } else if (value.type === "custom_message")
    value.content = stripImages(value.content);
  return value;
};

// src/server/sessions.ts
var idOf = (path) => {
  const stem = basename(path, ".jsonl");
  const cut = stem.indexOf("_");
  return cut >= 0 ? stem.slice(cut + 1) : stem;
};

class Tally {
  header;
  name;
  firstPrompt;
  lastTime;
  model;
  context = 0;
  cost = 0;
  prompts = 0;
  requests = 0;
  lastRole;
  open = new Set;
  add(line) {
    if (line.type === "session") {
      this.header = line;
      return;
    }
    const time = Date.parse(line.timestamp);
    if (Number.isFinite(time))
      this.lastTime = time;
    switch (line.type) {
      case "session_info":
        if (line.name)
          this.name = line.name;
        break;
      case "compaction":
      case "branch_summary":
      case "usage":
        this.cost += line.usage?.cost?.total ?? 0;
        break;
      case "message": {
        const m = line.message;
        if (!m || m.role === "system")
          break;
        this.lastRole = m.role;
        if (m.role === "user") {
          this.prompts += 1;
          this.firstPrompt ??= stripBlocks(textOf(m.content)).replace(/\s+/g, " ").trim().slice(0, 300);
        } else if (m.role === "assistant") {
          this.requests += 1;
          const u = m.usage;
          if (u) {
            this.cost += u.cost?.total ?? 0;
            const context = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
            if (context > 0)
              this.context = context;
          }
          this.model = { provider: m.provider, id: m.model };
          this.open = new Set(m.stopReason === "error" || m.stopReason === "aborted" ? [] : (m.content ?? []).flatMap((c) => c.type === "toolCall" ? [c.id] : []));
          this.lastRole = this.open.size ? "calls" : "assistant";
        } else if (m.role === "toolResult") {
          this.cost += m.usage?.cost?.total ?? 0;
          this.open.delete(m.toolCallId);
          this.lastRole = this.open.size ? "calls" : "toolResult";
        }
        break;
      }
    }
  }
  get inFlight() {
    switch (this.lastRole) {
      case "user":
      case "custom":
      case "toolResult":
        return "model";
      case "calls":
        return "tools";
      default:
        return;
    }
  }
  summary(path, modified, now = Date.now()) {
    const age = now - modified;
    const inFlight = this.inFlight;
    const created = this.header ? Date.parse(this.header.timestamp) : modified;
    return {
      id: idOf(path),
      path,
      cwd: this.header?.cwd ?? "",
      name: this.name,
      firstPrompt: this.firstPrompt,
      created: Number.isFinite(created) ? created : modified,
      modified,
      live: age < LIVE_MS,
      running: !!inFlight && age < RUNNING_MS,
      inFlight,
      model: this.model,
      context: this.context,
      cost: this.cost,
      prompts: this.prompts,
      requests: this.requests,
      parentSession: this.header?.parentSession
    };
  }
}

class SessionFile {
  path;
  reader;
  tally = new Tally;
  entries;
  listeners = new Set;
  mtime = 0;
  size = -1;
  constructor(path) {
    this.path = path;
    this.reader = new LineReader(path);
  }
  get id() {
    return idOf(this.path);
  }
  summary(now = Date.now()) {
    return this.tally.summary(this.path, this.mtime, now);
  }
  refresh() {
    let stat;
    try {
      stat = statSync2(this.path);
    } catch {
      return false;
    }
    if (stat.mtimeMs === this.mtime && stat.size === this.size)
      return false;
    this.mtime = stat.mtimeMs;
    this.size = stat.size;
    const { lines, reset } = this.reader.read();
    if (reset) {
      this.tally = new Tally;
      if (this.entries)
        this.entries = [];
    }
    const added = [];
    for (const line of lines) {
      const parsed = parseLine(line);
      if (!parsed)
        continue;
      this.tally.add(parsed);
      if (parsed.type !== "session")
        added.push(parsed);
    }
    if (this.entries) {
      if (reset)
        this.emit(this.snapshot());
      else {
        this.entries.push(...added);
        if (added.length)
          this.emit({ type: "append", entries: added });
        this.emit({ type: "summary", summary: this.summary() });
      }
    }
    return true;
  }
  snapshot() {
    return { type: "snapshot", summary: this.summary(), header: this.tally.header, entries: this.entries ?? [] };
  }
  emit(event) {
    for (const listener of this.listeners)
      listener(event);
  }
  load() {
    if (!this.entries) {
      this.reader = new LineReader(this.path);
      this.tally = new Tally;
      this.entries = [];
      this.size = -1;
      this.mtime = 0;
      const listeners = this.listeners;
      this.listeners = new Set;
      this.refresh();
      this.listeners = listeners;
    } else
      this.refresh();
    return this.snapshot();
  }
  subscribe(listener) {
    const snapshot = this.load();
    this.listeners.add(listener);
    listener(snapshot);
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size)
        this.entries = undefined;
    };
  }
  tick() {
    if (this.listeners.size)
      this.emit({ type: "summary", summary: this.summary() });
  }
  gone() {
    this.emit({ type: "gone" });
    this.listeners.clear();
  }
}
var listFiles = (dir) => {
  const out = [];
  let projects;
  try {
    projects = readdirSync(dir);
  } catch {
    return out;
  }
  for (const project of projects) {
    const path = join4(dir, project);
    let names;
    try {
      names = readdirSync(path);
    } catch {
      continue;
    }
    for (const name of names)
      if (name.endsWith(".jsonl"))
        out.push(join4(path, name));
  }
  return out;
};

// src/server/watch.ts
import { watch } from "node:fs";
import { join as join5 } from "node:path";
var POLL_MS = 3000;
var THROTTLE_MS = 250;

class SessionIndex {
  dir;
  files = new Map;
  listeners = new Set;
  watcher;
  timer;
  pending;
  flags = "";
  constructor(dir) {
    this.dir = dir;
  }
  start() {
    this.scan();
    try {
      this.watcher = watch(this.dir, { recursive: true }, (_event, name) => {
        if (!name)
          return this.scan();
        const path = join5(this.dir, name.toString());
        if (!path.endsWith(".jsonl"))
          return;
        const file = this.files.get(path);
        if (file) {
          if (file.refresh())
            this.changed();
        } else
          this.scan();
      });
      this.watcher.on("error", () => {
        return;
      });
    } catch {}
    this.timer = setInterval(() => this.poll(), POLL_MS);
    return this;
  }
  stop() {
    this.watcher?.close();
    if (this.timer)
      clearInterval(this.timer);
    if (this.pending)
      clearTimeout(this.pending);
  }
  scan() {
    const paths = new Set(listFiles(this.dir));
    let changed = false;
    for (const path of paths) {
      let file = this.files.get(path);
      if (!file) {
        file = new SessionFile(path);
        this.files.set(path, file);
        changed = true;
      }
      if (file.refresh())
        changed = true;
    }
    for (const [path, file] of this.files)
      if (!paths.has(path)) {
        file.gone();
        this.files.delete(path);
        changed = true;
      }
    if (changed)
      this.changed();
  }
  poll() {
    this.scan();
    const flags = this.list().map((s) => `${s.id}:${+s.live}${+s.running}`).join(",");
    if (flags !== this.flags) {
      this.flags = flags;
      for (const file of this.files.values())
        file.tick();
      this.changed();
    }
  }
  changed() {
    if (this.pending)
      return;
    this.pending = setTimeout(() => {
      this.pending = undefined;
      const list = this.list();
      for (const listener of this.listeners)
        listener(list);
    }, THROTTLE_MS);
  }
  list() {
    const now = Date.now();
    return [...this.files.values()].map((file) => file.summary(now)).sort((a, b) => b.modified - a.modified);
  }
  get(id) {
    const find = () => [...this.files.values()].find((file) => file.id === id);
    const found = find();
    if (found)
      return found;
    this.scan();
    return find();
  }
  onList(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

// src/cli.ts
var HELP = `pi-viewer: a live dashboard of your pi sessions, in the browser

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
`;
var { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: "string", short: "p" },
    host: { type: "string" },
    dir: { type: "string" },
    "no-open": { type: "boolean" },
    shared: { type: "boolean" },
    help: { type: "boolean", short: "h" }
  }
});
if (values.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
var dir = values.dir ? resolve2(values.dir) : sessionsDir();
var host = values.host ?? "127.0.0.1";
var local = host === "127.0.0.1" || host === "localhost" || host === "::1";
var here = dirname2(fileURLToPath(import.meta.url));
var client = [join6(here, "client"), join6(here, "..", "dist", "client")].find((path) => existsSync3(join6(path, "index.html")));
if (!existsSync3(dir))
  process.stderr.write(`pi-viewer: no sessions directory at ${dir} yet; watching for it.
`);
var index = new SessionIndex(dir).start();
var catalog;
var models = () => {
  if (!catalog || Date.now() - catalog.at > 5 * 60000)
    catalog = { at: Date.now(), models: loadCatalog(agentDir()).catch(() => []) };
  return catalog.models;
};
models();
var shared = values.shared === true;
var holders = 0;
var idle;
var quitIn = (ms) => {
  if (idle)
    clearTimeout(idle);
  idle = setTimeout(() => quit(), ms);
};
var onHold = (delta) => {
  holders += delta;
  if (holders === 0)
    quitIn(5000);
  else if (idle) {
    clearTimeout(idle);
    idle = undefined;
  }
};
var app = createApp({
  version,
  onHold: shared ? onHold : undefined,
  index,
  catalog: models,
  client,
  hosts: local ? new Set(["localhost", "127.0.0.1", "[::1]"]) : undefined
});
var target = (arg) => {
  if (!arg)
    return;
  if (arg.endsWith(".jsonl"))
    return idOf(arg);
  const list = index.list();
  return (list.find((s) => s.id === arg) ?? list.find((s) => s.id.startsWith(arg)))?.id ?? arg;
};
var listen = (port, tries = 10) => {
  app.once("error", (error) => {
    if (error.code === "EADDRINUSE" && shared)
      process.exit(0);
    if (error.code === "EADDRINUSE" && tries > 0 && !values.port)
      return listen(port + 1, tries - 1);
    process.stderr.write(`pi-viewer: ${error.message}
`);
    process.exit(1);
  });
  app.listen(port, host, () => {
    const shown = host.includes(":") ? `[${host}]` : host === "127.0.0.1" ? "localhost" : host;
    const id = target(positionals[0]);
    const url = `http://${shown}:${port}/${id ? `#/s/${encodeURIComponent(id)}` : ""}`;
    process.stdout.write(`pi-viewer: ${index.list().length} sessions in ${dir}
  ${url}
`);
    if (!client)
      process.stdout.write("  (API only: the client isn't built; `bun run dev` serves it)\n");
    if (!values["no-open"] && !shared && client)
      open(url);
    if (shared && holders === 0)
      quitIn(30000);
  });
};
listen(values.port ? Number(values.port) : 4545);
function quit() {
  index.stop();
  app.close();
  process.exit(0);
}
process.on("SIGINT", quit);
process.on("SIGTERM", quit);
