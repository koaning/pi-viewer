import type { PiContent, PiEntry, PiHeader, PiUsage } from "../src/pi/types"

// Small synthetic pi sessions, built the way pi appends entries: each one a child of the one before, unless `at`
// says otherwise. Times are milliseconds; entry timestamps are their ISO form.

export interface ToolInput {
  name: string
  args?: Record<string, unknown>
  /** The result, or undefined for a call still running. */
  result?: { at: number; durationMs?: number; output?: string; error?: boolean; usage?: PiUsage }
}

export interface RequestInput {
  /** The request went out. */
  start: number
  /** The reply was done (the entry's timestamp). */
  end: number
  durationMs?: number
  usage?: Partial<PiUsage>
  cost?: number
  text?: string
  thinking?: string
  model?: string
  provider?: string
  stop?: string
  error?: string
  tools?: ToolInput[]
}

const iso = (ms: number) => new Date(ms).toISOString()

export const usage = (u: Partial<PiUsage> = {}, cost = 0): PiUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  ...u,
  totalTokens: (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0),
  cost: u.cost ?? { input: cost / 2, output: cost / 2, cacheRead: 0, cacheWrite: 0, total: cost },
})

export function session(cwd = "/work/project") {
  let n = 0
  let calls = 0
  let last: string | null = null
  const entries: PiEntry[] = []
  const header: PiHeader = { type: "session", version: 3, id: "ses-1", timestamp: iso(0), cwd }
  const id = () => `e${String(++n).padStart(3, "0")}`
  const push = <T extends Omit<PiEntry, "id" | "parentId">>(entry: T, parent: string | null = last): string => {
    const e = { ...entry, id: id(), parentId: parent } as unknown as PiEntry
    entries.push(e)
    last = e.id
    return e.id
  }

  const api = {
    header,
    entries,
    /** Where the next entry hangs: the id of an earlier one, to branch. */
    at(parent: string | null) {
      last = parent
      return api
    },
    model(provider: string, modelId: string, at = 0) {
      push({ type: "model_change", timestamp: iso(at), provider, modelId })
      return api
    },
    system(at: number, text = "You are pi.", extra: { sections?: Record<string, string | null>; toolsAdded?: { name: string }[] } = {}) {
      push({ type: "message", timestamp: iso(at), message: { role: "system", content: text, timestamp: at, ...extra } })
      return api
    },
    user(at: number, text: string, images = 0) {
      const content: PiContent[] = [{ type: "text", text }, ...Array.from({ length: images }, () => ({ type: "image" as const, data: "", mimeType: "image/png" }))]
      return push({ type: "message", timestamp: iso(at), message: { role: "user", content, timestamp: at } })
    },
    request(r: RequestInput) {
      const tools = (r.tools ?? []).map((t) => ({ ...t, id: `call_${++calls}` }))
      const content: PiContent[] = [
        ...(r.thinking ? [{ type: "thinking" as const, thinking: r.thinking }] : []),
        ...(r.text ? [{ type: "text" as const, text: r.text }] : []),
        ...tools.map((t) => ({ type: "toolCall" as const, id: t.id, name: t.name, arguments: t.args ?? {} })),
      ]
      const id = push({
        type: "message",
        timestamp: iso(r.end),
        message: {
          role: "assistant",
          content,
          provider: r.provider ?? "anthropic",
          model: r.model ?? "claude-sonnet-4-5",
          usage: usage(r.usage, r.cost),
          stopReason: r.stop ?? (tools.length ? "toolUse" : "stop"),
          errorMessage: r.error,
          durationMs: r.durationMs,
          timestamp: r.start,
        },
      })
      for (const t of tools) {
        if (!t.result) continue
        push({
          type: "message",
          timestamp: iso(t.result.at),
          message: {
            role: "toolResult",
            toolCallId: t.id,
            toolName: t.name,
            content: [{ type: "text", text: t.result.output ?? "" }],
            isError: !!t.result.error,
            durationMs: t.result.durationMs,
            usage: t.result.usage,
            timestamp: t.result.at,
          },
        })
      }
      return id
    },
    compaction(at: number, summary: string, firstKeptEntryId?: string, u?: Partial<PiUsage>, cost = 0) {
      const id = `c${++n}`
      entries.push({
        type: "compaction",
        id,
        parentId: last,
        timestamp: iso(at),
        summary,
        firstKeptEntryId: firstKeptEntryId ?? id,
        tokensBefore: 50_000,
        usage: u && usage(u, cost),
      })
      last = id
      return id
    },
    bash(at: number, command: string, output: string, excludeFromContext = false) {
      push({ type: "message", timestamp: iso(at), message: { role: "bashExecution", command, output, exitCode: 0, excludeFromContext, timestamp: at } })
      return api
    },
    name(name: string, at = 0) {
      push({ type: "session_info", timestamp: iso(at), name })
      return api
    },
    usageEntry(at: number, u: Partial<PiUsage>, cost: number) {
      push({ type: "usage", timestamp: iso(at), kind: "cache_warm", provider: "anthropic", model: "claude-sonnet-4-5", usage: usage(u, cost) })
      return api
    },
    /** The file's lines, as pi writes them. */
    jsonl() {
      return [header, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n"
    },
  }
  return api
}
