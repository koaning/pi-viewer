import type { CostBreakdown, Message, ModelRef, TextContent, TokenUsageInfo, AssistantPart, AssistantTool, ToolState, JsonValue } from "../messages"
import type { PiContent, PiEntry, PiMessage, PiUsage } from "./types"

// pi's entries → the transcript model.ts reads. A request is one assistant message: its tool calls get their results
// (separate toolResult messages in pi) folded in, so a step carries its tools as OpenCode's do.

type Assistant = Extract<PiMessage, { role: "assistant" }>
type ToolResult = Extract<PiMessage, { role: "toolResult" }>

/** What the session is waiting on, judging by its last message: a model reply, its tools, or nothing. */
export type InFlight = "model" | "tools" | undefined

export interface Normalized {
  readonly messages: readonly Message[]
  /** The model selected last, for a request still in flight. */
  readonly model?: ModelRef
  readonly inFlight: InFlight
  /** When the last message on the branch was written. */
  readonly lastTime?: number
}

export const usageOf = (usage: PiUsage | undefined): TokenUsageInfo | undefined => {
  if (!usage) return undefined
  const reasoning = usage.reasoning ?? 0
  return {
    input: usage.input ?? 0,
    output: Math.max(0, (usage.output ?? 0) - reasoning),
    reasoning,
    cache: { read: usage.cacheRead ?? 0, write: usage.cacheWrite ?? 0 },
  }
}

export const costOfUsage = (usage: PiUsage | undefined): CostBreakdown | undefined => {
  const c = usage?.cost
  if (!c || typeof c.total !== "number") return undefined
  return { input: c.input ?? 0, output: c.output ?? 0, cacheRead: c.cacheRead ?? 0, cacheWrite: c.cacheWrite ?? 0, total: c.total }
}

export const textOf = (content: string | readonly PiContent[] | undefined): string => {
  if (typeof content === "string") return content
  return (content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("")
}

const images = (content: string | readonly PiContent[] | undefined) =>
  typeof content === "string" ? 0 : (content ?? []).filter((c) => c.type === "image").length

const texts = (content: readonly PiContent[] | undefined): TextContent[] =>
  (content ?? []).flatMap((c) => (c.type === "text" ? [{ type: "text" as const, text: c.text }] : []))

const isoTime = (iso: string | undefined, fallback: number) => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? t : fallback
}

const ref = (provider: string | undefined, model: string | undefined, variant?: string): ModelRef | undefined =>
  model ? { id: model, providerID: provider ?? "", variant } : undefined

const firstLine = (text: string, max = 200) => {
  const line = text.split("\n").find((l) => l.trim()) ?? ""
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** How a system message changed the prompt, for its marker. */
const systemLabel = (m: Extract<PiMessage, { role: "system" }>, first: boolean) => {
  if (first) return "System prompt"
  const parts: string[] = []
  const sections = Object.keys(m.sections ?? {})
  if (sections.length) parts.push(`sections ${sections.join(", ")}`)
  if (m.toolsAdded?.length) parts.push(`+ ${m.toolsAdded.map((t) => t.name).join(", ")}`)
  if (m.toolsRemoved?.length) parts.push(`− ${m.toolsRemoved.map((t) => t.name).join(", ")}`)
  return `System prompt changed${parts.length ? `: ${parts.join(" · ")}` : ""}`
}

const systemText = (m: Extract<PiMessage, { role: "system" }>) =>
  [textOf(m.content), ...Object.values(m.sections ?? {}).filter((s): s is string => typeof s === "string"), JSON.stringify(m.toolsAdded ?? [])].join("\n")

/**
 * The thinking a request did, as one part. pi doesn't time thinking, so its span is the reasoning share of the
 * output (by tokens when the provider counts them, else by characters), from the request's start.
 */
const reasoningPart = (m: Assistant, start: number, end: number): AssistantPart | undefined => {
  const thinking = m.content.flatMap((c) => (c.type === "thinking" ? [c.thinking ?? ""] : [])).join("\n")
  if (!m.content.some((c) => c.type === "thinking")) return undefined
  const output = m.usage?.output ?? 0
  const reasoning = m.usage?.reasoning ?? 0
  let fraction: number
  if (reasoning > 0 && output > 0) fraction = reasoning / output
  else {
    const other = m.content.reduce(
      (sum, c) => sum + (c.type === "text" ? c.text.length : c.type === "toolCall" ? JSON.stringify(c.arguments ?? {}).length : 0),
      0,
    )
    fraction = thinking.length + other > 0 ? thinking.length / (thinking.length + other) : 0
  }
  const span = Math.max(0, end - start) * Math.min(1, fraction)
  return { type: "reasoning", text: thinking, time: span > 0 ? { created: start, completed: start + span } : undefined }
}

const toolOf = (call: Extract<PiContent, { type: "toolCall" }>, streamed: number, result: ToolResult | undefined): AssistantTool => {
  const input = (call.arguments ?? {}) as JsonValue
  if (!result) return { type: "tool", id: call.id, name: call.name, time: { created: streamed }, state: { status: "running", input } }
  const completed = Math.max(streamed, result.timestamp)
  const ran = result.durationMs !== undefined ? Math.min(completed, Math.max(streamed, completed - result.durationMs)) : streamed
  const content = texts(result.content)
  const state: ToolState = result.isError
    ? { status: "error", input, content, error: { message: firstLine(content.map((c) => c.text).join("\n")) || "Tool failed" } }
    : { status: "completed", input, content }
  return {
    type: "tool",
    id: call.id,
    name: call.name,
    time: { created: streamed, ran, completed },
    state,
    usage: usageOf(result.usage),
    cost: costOfUsage(result.usage),
  }
}

/**
 * The transcript of a session's active branch.
 * @param running - The session is busy: a request whose reply pi hasn't written yet gets a pending stand-in.
 */
export const normalize = (branch: readonly PiEntry[], options: { readonly running?: boolean } = {}): Normalized => {
  const results = new Map<string, ToolResult>()
  /** Where an entry's content lives once folded: a tool result's entry id → its request's. */
  const owner = new Map<string, string>()
  const callOwner = new Map<string, string>()
  for (const entry of branch) {
    if (entry.type !== "message") continue
    const m = entry.message
    if (m.role === "assistant") for (const c of m.content ?? []) if (c.type === "toolCall") callOwner.set(c.id, entry.id)
    if (m.role === "toolResult") {
      if (!results.has(m.toolCallId)) results.set(m.toolCallId, m)
      const at = callOwner.get(m.toolCallId)
      if (at) owner.set(entry.id, at)
    }
  }

  const messages: Message[] = []
  let model: ModelRef | undefined
  let thinkingLevel: string | undefined
  let sawRequest = false
  let lastMessage: PiMessage | undefined
  let lastAssistant: Assistant | undefined
  let lastTime: number | undefined

  const position = new Map(branch.map((e, i) => [e.id, i]))
  /** The branch position of each message so far, to find where a compaction's kept range starts. */
  const sources: number[] = []
  const firstAtOrAfter = (entryId: string | undefined) => {
    if (!entryId) return undefined
    const at = position.get(owner.get(entryId) ?? entryId)
    if (at === undefined) return undefined
    const index = sources.findIndex((source) => source >= at)
    return index >= 0 ? messages[index]!.id : undefined
  }

  for (const [index, entry] of branch.entries()) {
    const at = isoTime(entry.timestamp, 0)
    const before = messages.length
    switch (entry.type) {
      case "model_change":
        model = ref(entry.provider, entry.modelId)
        break
      case "thinking_level_change":
        thinkingLevel = entry.thinkingLevel
        break
      case "compaction": {
        const keep = entry.firstKeptEntryId && entry.firstKeptEntryId !== entry.id ? entry.firstKeptEntryId : undefined
        messages.push({
          id: entry.id,
          type: "compaction",
          time: { created: at },
          summary: entry.summary ?? "",
          tokensBefore: entry.tokensBefore,
          keepFrom: firstAtOrAfter(keep),
          model: ref(entry.provider, entry.model),
          tokens: usageOf(entry.usage),
          cost: costOfUsage(entry.usage),
        })
        break
      }
      case "branch_summary":
        messages.push({
          id: entry.id,
          type: "branch",
          time: { created: at },
          summary: entry.summary ?? "",
          model: ref(entry.provider, entry.model),
          tokens: usageOf(entry.usage),
          cost: costOfUsage(entry.usage),
        })
        break
      case "usage": {
        const tokens = usageOf(entry.usage)
        if (tokens)
          messages.push({
            id: entry.id,
            type: "usage",
            time: { created: at },
            kind: entry.kind ?? "usage",
            model: ref(entry.provider, entry.model),
            tokens,
            cost: costOfUsage(entry.usage),
          })
        break
      }
      case "custom_message":
        messages.push({ id: entry.id, type: "synthetic", time: { created: at }, text: textOf(entry.content), description: entry.customType })
        break
      case "message": {
        const m = entry.message
        if (!m || typeof m !== "object") break
        const time = typeof m.timestamp === "number" ? m.timestamp : at
        if (m.role !== "system") {
          lastMessage = m
          lastTime = m.role === "assistant" ? isoTime(entry.timestamp, time) : time
        }
        switch (m.role) {
          case "user":
            messages.push({ id: entry.id, type: "user", time: { created: time }, text: textOf(m.content), files: images(m.content) || undefined })
            break
          case "assistant": {
            sawRequest = true
            lastAssistant = m
            const end = Math.max(time, m.durationMs !== undefined ? time + m.durationMs : isoTime(entry.timestamp, time))
            const content: AssistantPart[] = []
            const thinking = reasoningPart(m, time, end)
            if (thinking) content.push(thinking)
            const text = m.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("")
            if (text) content.push({ type: "text", text })
            const tools = m.content.flatMap((c) => (c.type === "toolCall" ? [toolOf(c, end, results.get(c.id))] : []))
            content.push(...tools)
            const done = tools.every((t) => t.time.completed !== undefined)
            const failed = m.stopReason === "error" || m.stopReason === "aborted"
            model = ref(m.provider, m.model) ?? model
            messages.push({
              id: entry.id,
              type: "assistant",
              agent: "",
              model: { id: m.model, providerID: m.provider, variant: m.thinkingLevel },
              time: {
                created: time,
                streamed: end,
                completed: done ? Math.max(end, ...tools.map((t) => t.time.completed!)) : undefined,
              },
              finish: m.stopReason,
              cost: costOfUsage(m.usage),
              tokens: usageOf(m.usage),
              error: failed ? { message: m.errorMessage || (m.stopReason === "aborted" ? "Aborted" : "Error") } : undefined,
              content,
            })
            break
          }
          case "toolResult":
            break
          case "system":
            messages.push({
              id: entry.id,
              type: "system",
              time: { created: time },
              text: systemText(m),
              description: systemLabel(m, !sawRequest),
              initial: !sawRequest,
            })
            break
          case "bashExecution":
            messages.push({
              id: entry.id,
              type: "shell",
              time: { created: time },
              command: m.command ?? "",
              output: m.output ?? "",
              excluded: !!m.excludeFromContext,
            })
            break
          case "custom":
            messages.push({ id: entry.id, type: "synthetic", time: { created: time }, text: textOf(m.content), description: m.customType })
            break
          case "branchSummary":
            messages.push({ id: entry.id, type: "branch", time: { created: time }, summary: m.summary ?? "" })
            break
          case "compactionSummary":
            messages.push({ id: entry.id, type: "compaction", time: { created: time }, summary: m.summary ?? "", tokensBefore: m.tokensBefore })
            break
        }
        break
      }
    }
    for (let i = before; i < messages.length; i++) sources.push(index)
  }

  const inFlight = inFlightOf(lastMessage, lastAssistant, results)
  if (options.running && inFlight === "model" && lastTime !== undefined) {
    const last = messages[messages.length - 1]
    messages.push({
      id: `pending:${last?.id ?? "start"}`,
      type: "assistant",
      agent: "",
      model: model ? { ...model, variant: thinkingLevel } : { id: "model", providerID: "" },
      time: { created: lastTime },
      content: [],
      pending: true,
    })
  }
  return { messages, model, inFlight, lastTime }
}

/**
 * What the session waits on after its last message. A prompt, or tool results that are all in, mean a request is out
 * to the model; a request whose tool calls lack results means tools are running. A finished reply means nothing,
 * unless it was cut short, which also means nothing.
 */
const inFlightOf = (
  last: PiMessage | undefined,
  request: Assistant | undefined,
  results: ReadonlyMap<string, ToolResult>,
): InFlight => {
  const toolsDone = (m: Assistant) => m.content.every((c) => c.type !== "toolCall" || results.has(c.id))
  if (!last) return undefined
  switch (last.role) {
    case "user":
    case "custom":
      return "model"
    case "toolResult":
      return request && !toolsDone(request) ? "tools" : "model"
    case "assistant":
      if (last.stopReason === "error" || last.stopReason === "aborted") return undefined
      if (!last.content?.some((c) => c.type === "toolCall")) return undefined
      return toolsDone(last) ? "model" : "tools"
    default:
      return undefined
  }
}
