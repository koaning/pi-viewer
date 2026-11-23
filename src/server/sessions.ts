import { readdirSync, statSync } from "node:fs"
import { basename, join } from "node:path"
import { LIVE_MS, RUNNING_MS, type SessionEvent, type SessionSummary } from "../api"
import { stripBlocks } from "../format"
import type { InFlight } from "../pi/normalize"
import { textOf } from "../pi/normalize"
import type { PiEntry, PiHeader, PiLine } from "../pi/types"
import { LineReader, parseLine } from "./tail"

/** A session's id from its file name, `<timestamp>_<id>.jsonl`. */
export const idOf = (path: string) => {
  const stem = basename(path, ".jsonl")
  const cut = stem.indexOf("_")
  return cut >= 0 ? stem.slice(cut + 1) : stem
}

/**
 * Running numbers for the session list, kept up as lines come in. They read the file in order and ignore its tree,
 * which is close enough for a list (the dashboard reads the active branch).
 */
export class Tally {
  header?: PiHeader
  name?: string
  firstPrompt?: string
  lastTime?: number
  model?: { provider: string; id: string }
  context = 0
  cost = 0
  prompts = 0
  requests = 0
  private lastRole?: string
  private open = new Set<string>()

  add(line: PiLine) {
    if (line.type === "session") {
      this.header = line
      return
    }
    const time = Date.parse(line.timestamp)
    if (Number.isFinite(time)) this.lastTime = time
    switch (line.type) {
      case "session_info":
        if (line.name) this.name = line.name
        break
      case "compaction":
      case "branch_summary":
      case "usage":
        this.cost += line.usage?.cost?.total ?? 0
        break
      case "message": {
        const m = line.message
        if (!m || m.role === "system") break
        this.lastRole = m.role
        if (m.role === "user") {
          this.prompts += 1
          // Blocks come out before the cut, while they still have their closing tags.
          this.firstPrompt ??= stripBlocks(textOf(m.content)).replace(/\s+/g, " ").trim().slice(0, 300)
        } else if (m.role === "assistant") {
          this.requests += 1
          const u = m.usage
          if (u) {
            this.cost += u.cost?.total ?? 0
            const context = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0)
            if (context > 0) this.context = context
          }
          this.model = { provider: m.provider, id: m.model }
          this.open = new Set(
            m.stopReason === "error" || m.stopReason === "aborted"
              ? []
              : (m.content ?? []).flatMap((c) => (c.type === "toolCall" ? [c.id] : [])),
          )
          this.lastRole = this.open.size ? "calls" : "assistant"
        } else if (m.role === "toolResult") {
          this.cost += m.usage?.cost?.total ?? 0
          this.open.delete(m.toolCallId)
          this.lastRole = this.open.size ? "calls" : "toolResult"
        }
        break
      }
    }
  }

  get inFlight(): InFlight {
    switch (this.lastRole) {
      case "user":
      case "custom":
      case "toolResult":
        return "model"
      case "calls":
        return "tools"
      default:
        return undefined
    }
  }

  summary(path: string, modified: number, now = Date.now()): SessionSummary {
    const age = now - modified
    const inFlight = this.inFlight
    const created = this.header ? Date.parse(this.header.timestamp) : modified
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
      parentSession: this.header?.parentSession,
    }
  }
}

type Listener = (event: SessionEvent) => void

/**
 * One session file, followed as it grows. It keeps only its tally until someone subscribes; then it keeps every entry
 * too, so a new subscriber gets a snapshot and the rest get what's appended.
 */
export class SessionFile {
  private reader: LineReader
  private tally = new Tally()
  private entries: PiEntry[] | undefined
  private listeners = new Set<Listener>()
  private mtime = 0
  private size = -1

  constructor(readonly path: string) {
    this.reader = new LineReader(path)
  }

  get id() {
    return idOf(this.path)
  }

  summary(now = Date.now()) {
    return this.tally.summary(this.path, this.mtime, now)
  }

  /** Reads what was appended. True when something changed. */
  refresh(): boolean {
    let stat
    try {
      stat = statSync(this.path)
    } catch {
      return false
    }
    if (stat.mtimeMs === this.mtime && stat.size === this.size) return false
    this.mtime = stat.mtimeMs
    this.size = stat.size
    const { lines, reset } = this.reader.read()
    if (reset) {
      this.tally = new Tally()
      if (this.entries) this.entries = []
    }
    const added: PiEntry[] = []
    for (const line of lines) {
      const parsed = parseLine(line)
      if (!parsed) continue
      this.tally.add(parsed)
      if (parsed.type !== "session") added.push(parsed)
    }
    if (this.entries) {
      if (reset) this.emit(this.snapshot())
      else {
        this.entries.push(...added)
        if (added.length) this.emit({ type: "append", entries: added })
        this.emit({ type: "summary", summary: this.summary() })
      }
    }
    return true
  }

  private snapshot(): SessionEvent {
    return { type: "snapshot", summary: this.summary(), header: this.tally.header, entries: this.entries ?? [] }
  }

  private emit(event: SessionEvent) {
    for (const listener of this.listeners) listener(event)
  }

  /** Everything in the file now. */
  load(): SessionEvent {
    if (!this.entries) {
      // Read it all again, keeping the entries this time.
      this.reader = new LineReader(this.path)
      this.tally = new Tally()
      this.entries = []
      this.size = -1
      this.mtime = 0
      const listeners = this.listeners
      this.listeners = new Set()
      this.refresh()
      this.listeners = listeners
    } else this.refresh()
    return this.snapshot()
  }

  subscribe(listener: Listener): () => void {
    const snapshot = this.load()
    this.listeners.add(listener)
    listener(snapshot)
    return () => {
      this.listeners.delete(listener)
      if (!this.listeners.size) this.entries = undefined
    }
  }

  /** Time passing can make a session stop being live or running without any write. */
  tick() {
    if (this.listeners.size) this.emit({ type: "summary", summary: this.summary() })
  }

  gone() {
    this.emit({ type: "gone" })
    this.listeners.clear()
  }
}

/** Every `*.jsonl` one level down: `<sessions>/<project>/<file>`. */
export const listFiles = (dir: string): string[] => {
  const out: string[] = []
  let projects: string[]
  try {
    projects = readdirSync(dir)
  } catch {
    return out
  }
  for (const project of projects) {
    const path = join(dir, project)
    let names: string[]
    try {
      names = readdirSync(path)
    } catch {
      continue
    }
    for (const name of names) if (name.endsWith(".jsonl")) out.push(join(path, name))
  }
  return out
}
