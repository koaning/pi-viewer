// src/extension.ts
import { spawn as spawn2 } from "node:child_process";
import { existsSync } from "node:fs";
import { get } from "node:http";
import { dirname, join as join2 } from "node:path";
import { fileURLToPath } from "node:url";

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

// src/server/sessions.ts
import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

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
      stat = statSync(this.path);
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

// src/extension.ts
var port = Number(process.env.PI_VIEWER_PORT) || 4545;
var base = `http://127.0.0.1:${port}`;
var url = `http://localhost:${port}/`;
var HOLD = Symbol.for("pi-viewer.hold");
var store = globalThis;
var here = dirname(fileURLToPath(import.meta.url));
var cli = () => [join2(here, "cli.js"), join2(here, "..", "dist", "cli.js")].find(existsSync);
var probe = async () => {
  try {
    const res = await fetch(`${base}/api/hello`, { signal: AbortSignal.timeout(500) });
    const body = await res.json().catch(() => {
      return;
    });
    return body?.app === "pi-viewer" ? "pi-viewer" : "other";
  } catch (error) {
    return error.name === "TimeoutError" ? "other" : "none";
  }
};
var sleep = (ms) => new Promise((done) => setTimeout(done, ms));
var ensure = async () => {
  let found = await probe();
  if (found === "other")
    return `port ${port} is taken by something else (set PI_VIEWER_PORT to use another)`;
  if (found === "pi-viewer")
    return;
  const path = cli();
  if (!path)
    return "dist/cli.js is missing; run `bun run build`";
  spawn2(process.execPath, [path, "--shared", "--port", String(port)], { detached: true, stdio: "ignore" }).unref();
  for (let i = 0;i < 50 && found !== "pi-viewer"; i++) {
    await sleep(100);
    found = await probe();
  }
  return found === "pi-viewer" ? undefined : "the server didn't start";
};
var hold = () => {
  if (store[HOLD])
    return;
  const req = get(`${base}/api/hold`, (res) => res.resume());
  req.on("socket", (socket) => socket.unref());
  const drop = () => {
    if (store[HOLD] === req)
      delete store[HOLD];
  };
  req.on("close", drop);
  req.on("error", drop);
  store[HOLD] = req;
};
var pageOf = (ctx) => {
  const file = ctx.sessionManager.getSessionFile();
  return file ? `${url}#/s/${encodeURIComponent(idOf(file))}` : url;
};
var viewer = async (ctx, page) => {
  const error = await ensure();
  if (error)
    return ctx.ui.notify(`pi-viewer: ${error}`, "error");
  hold();
  open(page);
  ctx.ui.notify(`pi-viewer: ${page}`, "info");
};
function extension_default(pi) {
  pi.registerFlag("viewer", { type: "boolean", default: false, description: "Open the pi-viewer dashboard of every session" });
  pi.on("session_start", (event, ctx) => {
    if (event.reason === "startup" && pi.getFlag("viewer"))
      viewer(ctx, url);
  });
  pi.registerCommand("viewer", {
    description: "Open this session in the pi-viewer dashboard",
    handler: (_args, ctx) => viewer(ctx, pageOf(ctx))
  });
}
export {
  extension_default as default
};
