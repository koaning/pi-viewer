import { watch, type FSWatcher } from "node:fs"
import { join } from "node:path"
import type { SessionSummary } from "../api"
import { listFiles, SessionFile } from "./sessions"

/** How often to look for changes fs.watch missed (network drives, some Linux setups), and for time passing. */
const POLL_MS = 3000
const THROTTLE_MS = 250

/** Every session under pi's sessions directory, followed live. */
export class SessionIndex {
  private files = new Map<string, SessionFile>()
  private listeners = new Set<(list: readonly SessionSummary[]) => void>()
  private watcher: FSWatcher | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private pending: ReturnType<typeof setTimeout> | undefined
  private flags = ""

  constructor(readonly dir: string) {}

  start() {
    this.scan()
    try {
      // Recursive watching works on macOS and Windows, and on Linux from Node 20.
      this.watcher = watch(this.dir, { recursive: true }, (_event, name) => {
        if (!name) return this.scan()
        const path = join(this.dir, name.toString())
        if (!path.endsWith(".jsonl")) return
        const file = this.files.get(path)
        if (file) {
          if (file.refresh()) this.changed()
        } else this.scan()
      })
      this.watcher.on("error", () => undefined)
    } catch {
      // No watching here: polling covers it.
    }
    this.timer = setInterval(() => this.poll(), POLL_MS)
    return this
  }

  stop() {
    this.watcher?.close()
    if (this.timer) clearInterval(this.timer)
    if (this.pending) clearTimeout(this.pending)
  }

  /** Finds new and deleted files, and reads what was appended to the rest. */
  scan() {
    const paths = new Set(listFiles(this.dir))
    let changed = false
    for (const path of paths) {
      let file = this.files.get(path)
      if (!file) {
        file = new SessionFile(path)
        this.files.set(path, file)
        changed = true
      }
      if (file.refresh()) changed = true
    }
    for (const [path, file] of this.files)
      if (!paths.has(path)) {
        file.gone()
        this.files.delete(path)
        changed = true
      }
    if (changed) this.changed()
  }

  private poll() {
    this.scan()
    // A session stops being live or running as time passes, without a write to say so.
    const flags = this.list()
      .map((s) => `${s.id}:${+s.live}${+s.running}`)
      .join(",")
    if (flags !== this.flags) {
      this.flags = flags
      for (const file of this.files.values()) file.tick()
      this.changed()
    }
  }

  private changed() {
    if (this.pending) return
    this.pending = setTimeout(() => {
      this.pending = undefined
      const list = this.list()
      for (const listener of this.listeners) listener(list)
    }, THROTTLE_MS)
  }

  /** Newest first. */
  list(): SessionSummary[] {
    const now = Date.now()
    return [...this.files.values()]
      .map((file) => file.summary(now))
      .sort((a, b) => b.modified - a.modified)
  }

  /** The session with this id; looks again on a miss, for a file so new that watching hasn't seen it yet. */
  get(id: string): SessionFile | undefined {
    const find = () => [...this.files.values()].find((file) => file.id === id)
    const found = find()
    if (found) return found
    this.scan()
    return find()
  }

  onList(listener: (list: readonly SessionSummary[]) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
