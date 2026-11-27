import type { SessionSummary } from "../api"
import { firstLine } from "../format"

// The session list's plain helpers: what a session is called, which project it belongs to, and when it was.

const HOME = /^(\/Users\/[^/]+|\/home\/[^/]+)(?=\/|$)/

/** The cwd with the home directory as `~`. The browser doesn't know $HOME, but /Users/x and /home/x will do. */
export const tilde = (cwd: string) => {
  const home = HOME.exec(cwd)?.[1]
  return home ? `~${cwd.slice(home.length)}` : cwd
}

export interface Project {
  /** What sessions are grouped by: the repository, for a worktree. */
  readonly key: string
  readonly name: string
  /** The worktree, when the cwd is one (Conductor's). */
  readonly workspace?: string
}

const last = (path: string) => path.split("/").pop() || path

/** The project a cwd belongs to. Conductor's worktrees fold into their repository. */
export const projectOf = (path: string): Project => {
  const cwd = path.replace(/(.)\/+$/, "$1")
  if (!cwd) return { key: "", name: "(unknown directory)" }
  const workspaces = /^(.*\/conductor\/workspaces\/([^/]+))\/([^/]+)/.exec(cwd)
  if (workspaces) return { key: workspaces[1]!, name: workspaces[2]!, workspace: workspaces[3] }
  const dotted = /^(.+)\/\.conductor\/([^/]+)/.exec(cwd)
  if (dotted) return { key: dotted[1]!, name: last(dotted[1]!), workspace: dotted[2] }
  const short = tilde(cwd)
  return { key: cwd, name: short === "~" ? "~" : last(cwd) }
}

/** A model id without its provider prefix, tag or date: `deepseek/deepseek-v4:free` → `deepseek-v4`. */
export const shortModel = (id: string | undefined) =>
  (id ?? "")
    .replace(/^.*\//, "")
    .replace(/:.*$/, "")
    .replace(/-\d{8}$/, "")

/** A session's title: its /name, else its first prompt, cleaned of what tools wrap around it. */
export const titleOf = (s: Pick<SessionSummary, "name" | "firstPrompt">) => {
  if (s.name) return s.name
  const text = firstLine(s.firstPrompt ?? "", 400)
    // A skill block cut off before its closing tag.
    .replace(/^<skill\b[^>]*?\bname="([^"]+)"[\s\S]*$/, "/$1")
    // Any other tag left open at the start.
    .replace(/^<[A-Za-z][\w-]*(\s[^>]*)?>\s*/, "")
    .trim()
  return firstLine(text, 140) || "(no prompt yet)"
}

/** One prompt and one reply at most: title generators, pings, a lone /clear. */
export const isOneShot = (s: Pick<SessionSummary, "prompts" | "requests">) => s.prompts <= 1 && s.requests <= 1

const DAY = 86_400_000
const midnight = (time: number) => {
  const d = new Date(time)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** How long ago, short: `just now`, `18m`, `3h`, `Mon`, `Jun 30`, `Jun 30, 2025`. */
export const ago = (time: number, now = Date.now()) => {
  const s = Math.max(0, (now - time) / 1000)
  if (s < 45) return "just now"
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`
  if (s < 86_400) return `${Math.round(s / 3600)}h`
  const date = new Date(time)
  if (now - time < 6 * DAY) return date.toLocaleDateString("en", { weekday: "short" })
  if (date.getFullYear() === new Date(now).getFullYear()) return date.toLocaleDateString("en", { month: "short", day: "numeric" })
  return date.toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" })
}

/** The time of day next to `ago`, `14:32`; empty for another year, where the date is long enough. */
export const stamp = (time: number, now = Date.now()) =>
  new Date(time).getFullYear() === new Date(now).getFullYear()
    ? new Date(time).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
    : ""

export const BUCKETS = ["Today", "Yesterday", "This week", "Earlier"] as const
export type Bucket = (typeof BUCKETS)[number]

/** Which day-group a time falls in, by local calendar day. */
export const bucketOf = (time: number, now = Date.now()): Bucket => {
  const today = midnight(now)
  if (time >= today) return "Today"
  if (time >= today - DAY) return "Yesterday"
  if (time >= today - 6 * DAY) return "This week"
  return "Earlier"
}
