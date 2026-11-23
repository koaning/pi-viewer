import type {
  AssistantMessage,
  AssistantTool,
  CostBreakdown,
  JsonValue,
  Message,
  ModelCost,
  ModelRef,
  TokenUsageInfo,
} from "./messages"
import { costOf, NO_COST, sumCosts, type Cost, type PriceLookup } from "./pricing"

// Everything here is pure: messages in, numbers out. The dashboard feeds it a session's transcript, as
// `pi/normalize.ts` makes it from pi's session file.

/** Token counts of one or more requests. */
export interface Usage {
  /** Uncached input tokens. */
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

export const ZERO: Usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }

export const usageOf = (tokens: TokenUsageInfo | undefined): Usage =>
  tokens
    ? {
        input: tokens.input,
        output: tokens.output,
        reasoning: tokens.reasoning,
        cacheRead: tokens.cache.read,
        cacheWrite: tokens.cache.write,
      }
    : ZERO

export const addUsage = (a: Usage, b: Usage): Usage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  reasoning: a.reasoning + b.reasoning,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
})

/** What the request sent: the context window it filled. */
export const contextOf = (u: Usage) => u.input + u.cacheRead + u.cacheWrite
/** Every token billed in some way. */
export const totalOf = (u: Usage) => contextOf(u) + u.output + u.reasoning

/** A rough token count for text the model saw. Good enough to compare shares, which are then calibrated. */
export const estimateTokens = (chars: number) => Math.round(chars / 4)

export interface ToolCall {
  readonly id: string
  readonly name: string
  readonly status: "streaming" | "running" | "completed" | "error"
  /** A short description of the input: the path, command, pattern or URL. */
  readonly summary: string
  readonly input: unknown
  /** The model started emitting the call. */
  readonly created: number
  /** The tool started executing. */
  readonly ran?: number
  readonly completed?: number
  /** Execution time, `ran → completed` (or `→ now` while running). */
  readonly ms: number
  readonly inputChars: number
  /** Characters of text the tool returned to the model. */
  readonly outputChars: number
  /** The start of what the tool returned, for previews. */
  readonly output: string
  readonly error?: string
  /** Model work the tool did itself (a subagent, say), which pi counts toward the session. */
  readonly usage?: Usage
  readonly cost?: Cost
}

export interface Step {
  readonly id: string
  readonly agent: string
  readonly model: ModelRef
  readonly created: number
  /** The model finished generating; tools run after this. */
  readonly streamed?: number
  readonly completed?: number
  readonly running: boolean
  /** `created → streamed`: the model thinking and writing. */
  readonly modelMs: number
  /** `streamed → completed`: the step's tools running (and waiting for permission). */
  readonly toolMs: number
  readonly ms: number
  /** From the first reasoning or tool token, when the step records one. */
  readonly ttftMs?: number
  /** Time spent in reasoning parts, when the transcript times them; part of `modelMs`. */
  readonly thinkingMs: number
  /** When each reasoning part ran, `[start, end]`. */
  readonly thinking: readonly (readonly [number, number])[]
  readonly usage: Usage
  readonly context: number
  readonly cost: Cost
  readonly finish?: string
  readonly error?: string
  readonly textChars: number
  readonly reasoningChars: number
  readonly text: string
  readonly reasoning: string
  readonly tools: readonly ToolCall[]
  /** A request out to the model that pi hasn't written yet: it writes each one when the reply is done. */
  readonly pending: boolean
}

/** Something in the transcript that isn't a model step: a compaction, a shell command, a prompt change. */
export interface Marker {
  readonly id: string
  readonly kind: "compaction" | "branch" | "shell" | "system" | "synthetic" | "usage"
  readonly time: number
  readonly label: string
  readonly usage: Usage
  readonly cost: Cost
}

export interface Turn {
  readonly index: number
  /** The user message's id; the session's first id for activity before any prompt. */
  readonly id: string
  readonly prompt: string
  readonly start: number
  readonly end: number
  readonly running: boolean
  readonly steps: readonly Step[]
  readonly markers: readonly Marker[]
  /** `start → end`. */
  readonly ms: number
  readonly modelMs: number
  readonly toolMs: number
  /** Time in the turn that no step accounts for: queueing, retries, gaps between steps. */
  readonly otherMs: number
  readonly usage: Usage
  readonly cost: Cost
  readonly toolCalls: number
  /** The largest context any of its steps sent. */
  readonly peakContext: number
  /** What its tools spent on model work of their own; part of `cost`. */
  readonly toolCost: Cost
}

export interface Pricing {
  readonly lookup: PriceLookup
  /** Rates for models with no price of their own, from the model the user picked; undefined for none. */
  readonly fallback?: readonly ModelCost[]
}

const NO_PRICING: Pricing = { lookup: () => undefined }

/** How much of a tool's output or a step's text the dashboard keeps for previews. */
const PREVIEW = 4000

const str = (value: JsonValue | undefined) => (typeof value === "string" ? value : undefined)

const SUMMARY_KEYS = ["file_path", "filePath", "path", "command", "pattern", "url", "query", "description", "prompt", "name"]

/** The one field of a tool's input that says what it did, shortened. */
export const summarize = (input: unknown): string => {
  if (typeof input === "string") return clip(input)
  if (!input || typeof input !== "object") return ""
  const record = input as Record<string, JsonValue>
  for (const key of SUMMARY_KEYS) {
    const value = str(record[key])
    if (value) return clip(value)
  }
  const first = Object.values(record).find((value) => typeof value === "string")
  return typeof first === "string" ? clip(first) : ""
}

const clip = (text: string, max = 90) => {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

const jsonChars = (value: unknown) => {
  if (value === undefined) return 0
  if (typeof value === "string") return value.length
  try {
    return JSON.stringify(value).length
  } catch {
    return 0
  }
}

const reportedCost = (cost: CostBreakdown | undefined, usage: Usage, model: ModelRef | undefined, pricing: Pricing): Cost =>
  costOf({
    reported: cost?.total,
    reportedSplit: cost,
    usage,
    context: contextOf(usage),
    model,
    lookup: pricing.lookup,
    fallback: pricing.fallback,
  })

const toolOf = (part: AssistantTool, now: number, live = false, pricing: Pricing = NO_PRICING): ToolCall => {
  const state = part.state
  const input = state.input
  const content = state.status === "completed" || state.status === "error" ? state.content : undefined
  const texts = (content ?? []).flatMap((c) => (c.type === "text" ? [c.text] : []))
  const outputChars = texts.reduce((sum, text) => sum + text.length, 0)
  const usage = part.usage && usageOf(part.usage)
  // Only what pi priced: the tool's model is unknown, so there's nothing to estimate with.
  const cost = usage && part.cost && part.cost.total > 0 ? reportedCost(part.cost, usage, undefined, pricing) : undefined
  // Calls without `ran` run from when the model emitted them.
  const ran = part.time.ran ?? part.time.created
  const end = part.time.completed ?? (live && state.status === "running" ? now : undefined)
  return {
    id: part.id,
    name: part.name,
    status: state.status,
    summary: summarize(input),
    input,
    created: part.time.created,
    ran: part.time.ran,
    completed: part.time.completed,
    ms: end !== undefined ? Math.max(0, end - ran) : 0,
    inputChars: jsonChars(input),
    outputChars,
    output: texts.join("\n").slice(0, PREVIEW),
    error: state.status === "error" ? state.error.message : undefined,
    usage,
    cost,
  }
}

/**
 * @param live - The session is busy, so a step without `completed` is still going. Without it, such a step was
 *   interrupted, and ends at the last time it recorded.
 */
export const stepOf = (
  message: AssistantMessage,
  now: number,
  pricing: Pricing = NO_PRICING,
  live = false,
): Step => {
  const usage = usageOf(message.tokens)
  const context = contextOf(usage)
  const running = live && message.time.completed === undefined && !message.error
  let text = ""
  let reasoning = ""
  let thinkingMs = 0
  const thinking: [number, number][] = []
  let first: number | undefined
  const tools: ToolCall[] = []
  for (const part of message.content) {
    if (part.type === "text") text += part.text
    else if (part.type === "reasoning") {
      reasoning += part.text
      if (part.time) {
        first = Math.min(first ?? Infinity, part.time.created)
        const done = part.time.completed ?? (running ? now : undefined)
        if (done !== undefined) {
          thinkingMs += Math.max(0, done - part.time.created)
          thinking.push([part.time.created, done])
        }
      }
    } else {
      tools.push(toolOf(part, now, running, pricing))
      first = Math.min(first ?? Infinity, part.time.created)
    }
  }
  // An interrupted step has no `completed`: it ends at the last time it, or one of its tools, recorded.
  const end =
    message.time.completed ??
    (running
      ? now
      : Math.max(message.time.streamed ?? message.time.created, ...tools.map((t) => t.completed ?? t.created)))
  // The model stops generating at `streamed`, and the step's tools run after. Older transcripts don't record it: there
  // the last tool call to start marks it.
  const lastCall = tools.reduce<number | undefined>((max, t) => Math.max(max ?? -Infinity, t.ran ?? t.created), undefined)
  const modelEnd = Math.min(end, message.time.streamed ?? lastCall ?? end)
  return {
    id: message.id,
    agent: message.agent,
    model: message.model,
    created: message.time.created,
    streamed: message.time.streamed,
    completed: message.time.completed,
    running,
    modelMs: Math.max(0, modelEnd - message.time.created),
    toolMs: Math.max(0, end - modelEnd),
    ms: Math.max(0, end - message.time.created),
    ttftMs: first !== undefined ? Math.max(0, first - message.time.created) : undefined,
    usage,
    context,
    cost: message.tokens ? reportedCost(message.cost, usage, message.model, pricing) : NO_COST,
    finish: message.finish,
    error: message.error?.message,
    textChars: text.length,
    reasoningChars: reasoning.length,
    text: text.slice(0, PREVIEW),
    reasoning: reasoning.slice(0, PREVIEW),
    thinkingMs: Math.min(thinkingMs, Math.max(0, modelEnd - message.time.created)),
    thinking,
    tools,
    pending: !!message.pending,
  }
}

const markerOf = (message: Message, pricing: Pricing): Marker | undefined => {
  const plain = (kind: Marker["kind"], label: string): Marker => ({
    id: message.id,
    kind,
    time: message.time.created,
    label,
    usage: ZERO,
    cost: NO_COST,
  })
  const work = (kind: Marker["kind"], label: string, tokens: TokenUsageInfo | undefined, cost: CostBreakdown | undefined, model?: ModelRef): Marker => {
    const usage = usageOf(tokens)
    return { ...plain(kind, label), usage, cost: tokens ? reportedCost(cost, usage, model, pricing) : NO_COST }
  }
  switch (message.type) {
    case "compaction":
      return work(
        "compaction",
        `Compaction${message.tokensBefore ? ` of ${Math.round(message.tokensBefore / 1000)}k tokens` : ""}`,
        message.tokens,
        message.cost,
        message.model,
      )
    case "branch":
      return work("branch", "Branch summary", message.tokens, message.cost, message.model)
    case "usage":
      return work("usage", message.kind === "cache_warm" ? "Cache warming" : `Model use: ${message.kind}`, message.tokens, message.cost, message.model)
    case "shell":
      return plain("shell", `$ ${clip(message.command, 60)}${message.excluded ? " (kept out of context)" : ""}`)
    case "system":
      // The prompt the session started with is the system share's baseline, not an event.
      return message.initial ? undefined : plain("system", clip(message.description ?? "System prompt changed", 60))
    case "synthetic":
      return plain("synthetic", clip(message.description ? `${message.description}: ${message.text}` : message.text, 60))
    default:
      return undefined
  }
}

const finishTurn = (
  draft: { index: number; id: string; prompt: string; start: number; steps: Step[]; markers: Marker[] },
  now: number,
  last: boolean,
  running: boolean,
): Turn => {
  const steps = draft.steps
  const stepsRunning = steps.some((s) => s.running)
  const isRunning = stepsRunning || (last && running)
  const ends = [
    ...steps.map((s) => s.completed ?? (s.running ? now : s.created + s.ms)),
    ...draft.markers.map((m) => m.time),
  ]
  const end = isRunning ? now : Math.max(draft.start, ...ends)
  const modelMs = steps.reduce((sum, s) => sum + s.modelMs, 0)
  const toolMs = steps.reduce((sum, s) => sum + s.toolMs, 0)
  const ms = Math.max(0, end - draft.start)
  const tools = steps.flatMap((s) => s.tools)
  const toolCost = sumCosts(tools.flatMap((t) => (t.cost ? [t.cost] : [])))
  return {
    ...draft,
    end,
    running: isRunning,
    ms,
    modelMs,
    toolMs,
    otherMs: Math.max(0, ms - modelMs - toolMs),
    usage: [...steps.map((s) => s.usage), ...tools.flatMap((t) => (t.usage ? [t.usage] : [])), ...draft.markers.map((m) => m.usage)].reduce(
      addUsage,
      ZERO,
    ),
    cost: sumCosts([
      // A request still out has no tokens yet; its price isn't unknown, it just isn't in.
      ...steps.filter((s) => !s.pending).map((s) => s.cost),
      ...(toolCost.kind === "none" ? [] : [toolCost]),
      ...draft.markers.filter((m) => m.cost.kind !== "none").map((m) => m.cost),
    ]),
    toolCalls: tools.length,
    peakContext: steps.reduce((max, s) => Math.max(max, s.context), 0),
    toolCost,
  }
}

/**
 * Splits a transcript into turns: each user message and the steps and markers that follow it, until the next user
 * message. Anything before the first prompt is turn 0 with an empty prompt.
 *
 * Notes after a turn's last step (prompt changes, extension messages, shell commands, branch summaries, cache warming)
 * wait for what comes next: a step keeps them in this turn, a prompt takes them into its own. Many are filed just
 * before the prompt they go with, and they shouldn't stretch the turn before it over the idle time in between.
 * Compactions are work of their own and stay where they ran.
 *
 * @param running - The session is busy, so its last turn is still going even between steps.
 */
export const turnsOf = (
  messages: readonly Message[],
  options: { readonly now: number; readonly running?: boolean; readonly pricing?: Pricing },
): Turn[] => {
  const pricing = options.pricing ?? NO_PRICING
  let lastStep = -1
  messages.forEach((m, i) => {
    if (m.type === "assistant") lastStep = i
  })
  const turns: Turn[] = []
  let draft: Parameters<typeof finishTurn>[0] | undefined
  let pending: Marker[] = []
  const open = (id: string, start: number) =>
    (draft ??= { index: 0, id, prompt: "", start, steps: [], markers: [] })
  const flush = () => {
    if (pending.length) open(pending[0]!.id, pending[0]!.time).markers.push(...pending)
    pending = []
  }
  for (const [index, message] of messages.entries()) {
    if (message.type === "user") {
      if (draft) turns.push(finishTurn(draft, options.now, false, false))
      draft = { index: turns.length, id: message.id, prompt: message.text, start: message.time.created, steps: [], markers: pending }
      pending = []
      continue
    }
    if (message.type !== "assistant") {
      const marker = markerOf(message, pricing)
      if (!marker) continue
      if (marker.kind !== "compaction") pending.push(marker)
      else {
        flush()
        open(message.id, marker.time).markers.push(marker)
      }
      continue
    }
    flush()
    open(message.id, message.time.created).steps.push(stepOf(message, options.now, pricing, !!options.running && index === lastStep))
  }
  flush()
  if (draft) turns.push(finishTurn(draft, options.now, true, !!options.running))
  return turns
}

export interface Totals {
  readonly turns: number
  readonly steps: number
  readonly toolCalls: number
  /** First message → last activity. */
  readonly wallMs: number
  readonly modelMs: number
  readonly toolMs: number
  readonly usage: Usage
  readonly cost: Cost
}

export const totalsOf = (turns: readonly Turn[]): Totals => ({
  turns: turns.filter((t) => t.prompt !== "" || t.index > 0).length,
  steps: turns.reduce((sum, t) => sum + t.steps.length, 0),
  toolCalls: turns.reduce((sum, t) => sum + t.toolCalls, 0),
  wallMs: turns.length ? Math.max(0, turns[turns.length - 1]!.end - turns[0]!.start) : 0,
  modelMs: turns.reduce((sum, t) => sum + t.modelMs, 0),
  toolMs: turns.reduce((sum, t) => sum + t.toolMs, 0),
  usage: turns.map((t) => t.usage).reduce(addUsage, ZERO),
  cost: sumCosts(turns.map((t) => t.cost)),
})

export type Bucket =
  | { readonly kind: "system" }
  | { readonly kind: "user" }
  | { readonly kind: "summary" }
  | { readonly kind: "assistant" }
  | { readonly kind: "reasoning" }
  | { readonly kind: "calls" }
  | { readonly kind: "tool"; readonly name: string }

/** A bucket's key: its kind, or `tool:<name>` for a tool's results. */
export const bucketKey = (bucket: Bucket) => (bucket.kind === "tool" ? `tool:${bucket.name}` : bucket.kind)

export const bucketOf = (key: string): Bucket =>
  key.startsWith("tool:") ? { kind: "tool", name: key.slice(5) } : ({ kind: key } as Bucket)

export interface Share {
  readonly bucket: Bucket
  /** Estimated tokens of the context window, calibrated so the shares add up to `total`. */
  readonly tokens: number
}

/** What the model produced in one request, in tokens, split by where it went. */
export interface Produced {
  readonly reasoning: number
  readonly text: number
  /** Arguments written for tool calls. */
  readonly calls: number
}

/** One request: what its context held, and what it produced. */
export interface ContextPoint {
  readonly step: string
  readonly time: number
  readonly turn: number
  /** The context it sent, as the provider counted it. */
  readonly total: number
  /** The context's makeup by bucket key; adds up to `total`. */
  readonly parts: Readonly<Record<string, number>>
  /** How far the raw estimate was scaled to match the measured total; 1 is a perfect estimate. */
  readonly scale: number
  readonly produced: Produced
  readonly model: ModelRef
}

export interface Timeline {
  readonly points: readonly ContextPoint[]
  /** For each completed compaction, the index of the first point after it. */
  readonly compactions: readonly number[]
}

/**
 * Splits a request's output tokens by what they went to. Providers that count reasoning apart give it directly; the
 * rest of the output is split between text and tool-call arguments by their characters. Providers that fold reasoning
 * into output get all three split by characters.
 */
export const producedOf = (input: {
  readonly output: number
  readonly reasoning: number
  readonly reasoningChars: number
  readonly textChars: number
  readonly callChars: number
}): Produced => {
  const split = (tokens: number, parts: readonly number[]) => {
    const sum = parts.reduce((a, b) => a + b, 0)
    if (sum === 0) return parts.map((_, i) => (i === parts.length - 2 ? tokens : 0))
    return parts.map((p) => (tokens * p) / sum)
  }
  if (input.reasoning > 0) {
    const [text, calls] = split(input.output, [input.textChars, input.callChars])
    return { reasoning: input.reasoning, text: text!, calls: calls! }
  }
  const [reasoning, text, calls] = split(input.output, [input.reasoningChars, input.textChars, input.callChars])
  return { reasoning: reasoning!, text: text!, calls: calls! }
}

// The messages that open a turn in turnsOf, so request points get the turn their step is in. Notes before the first
// prompt go with it; a request or compaction before it is turn 0.
const COUNTED = new Set(["user", "assistant", "compaction"])

/** Roughly what an attached image costs in context, in characters (≈ 1.5k tokens). */
const IMAGE_CHARS = 6000

/**
 * What every request's context held, from the session's start. Each total is measured: the request's input + cache
 * tokens. Its makeup is estimated from the transcript before it (characters ÷ 4), with one measured anchor: the first
 * request after the start or a compaction carried the system prompt and tool definitions plus very little else, so
 * that request's context minus the little else is the system share. The rest is spread over the transcript's parts in
 * proportion to their estimates, so each request's parts add up to its total.
 *
 * A compaction leaves its summary plus the messages from its kept range on: what each message added is logged, so the
 * kept ones can be added back.
 */
export const contextTimeline = (messages: readonly Message[]): Timeline => {
  const points: ContextPoint[] = []
  const compactions: number[] = []
  let chars = new Map<string, number>()
  let log: { readonly id: string; readonly key: string; readonly n: number }[] = []
  let system: number | undefined
  let turn = -1
  let current = ""
  const put = (key: string, n: number) => chars.set(key, (chars.get(key) ?? 0) + n)
  const add = (key: string, n: number) => {
    if (n <= 0) return
    put(key, n)
    log.push({ id: current, key, n })
  }

  for (const message of messages) {
    current = message.id
    if (COUNTED.has(message.type)) turn = message.type === "user" || turn < 0 ? turn + 1 : turn
    switch (message.type) {
      case "user":
        add("user", message.text.length + (message.files ?? 0) * IMAGE_CHARS)
        break
      case "synthetic":
        add("user", message.text.length)
        break
      case "shell":
        if (!message.excluded) add("user", message.command.length + message.output.length)
        break
      case "branch":
        add("summary", message.summary.length)
        break
      case "compaction": {
        // What the model sees from now on in place of everything before: the summary, then the kept messages.
        const from = message.keepFrom ? log.findIndex((l) => l.id === message.keepFrom) : -1
        const kept = from >= 0 ? log.slice(from) : []
        chars = new Map()
        log = []
        add("summary", message.summary.length)
        for (const l of kept) {
          put(l.key, l.n)
          log.push(l)
        }
        system = undefined
        compactions.push(points.length)
        break
      }
      case "assistant": {
        const usage = usageOf(message.tokens)
        const total = contextOf(usage)
        let reasoningChars = 0
        let textChars = 0
        let callChars = 0
        if (message.tokens && total > 0) {
          const estimates = [...chars].map(([key, n]) => [key, estimateTokens(n)] as const)
          const estimated = estimates.reduce((sum, [, n]) => sum + n, 0)
          system ??= Math.min(total, Math.max(0, total - estimated))
          const anchored = Math.min(system, total)
          const rest = total - anchored
          const scale = estimated > 0 ? rest / estimated : 1
          const parts: Record<string, number> = { system: estimated > 0 ? anchored : total }
          if (estimated > 0) for (const [key, n] of estimates) if (n > 0) parts[key] = n * scale
          for (const part of message.content) {
            if (part.type === "text") textChars += part.text.length
            else if (part.type === "reasoning") reasoningChars += part.text.length
            else callChars += jsonChars(part.state.input) + part.name.length
          }
          points.push({
            step: message.id,
            time: message.time.created,
            turn: Math.max(0, turn),
            total,
            parts,
            scale,
            produced: producedOf({ output: usage.output, reasoning: usage.reasoning, reasoningChars, textChars, callChars }),
            model: message.model,
          })
        }
        // What this request produced is in the context of the next one.
        for (const part of message.content) {
          if (part.type === "text") add("assistant", part.text.length)
          else if (part.type === "reasoning") add("reasoning", part.text.length)
          else {
            const tool = toolOf(part, 0)
            add("calls", tool.inputChars + tool.name.length)
            add(`tool:${tool.name}`, tool.outputChars)
          }
        }
        break
      }
    }
  }
  return { points, compactions }
}

export interface Breakdown {
  /** The context the latest request sent, as the provider counted it. */
  readonly total: number
  /** Largest first. */
  readonly shares: readonly Share[]
  readonly scale: number
  /** The model the latest request went to. */
  readonly model?: ModelRef
}

/** A point's parts as shares, largest first. */
export const sharesOf = (point: ContextPoint): Share[] =>
  Object.entries(point.parts)
    .map(([key, tokens]) => ({ bucket: bucketOf(key), tokens: Math.round(tokens) }))
    .filter((share) => share.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)

/** What fills the context now: the latest request's makeup. See `contextTimeline`. */
export const contextBreakdown = (messages: readonly Message[], timeline = contextTimeline(messages)): Breakdown | undefined => {
  const latest = timeline.points[timeline.points.length - 1]
  if (!latest) return undefined
  return { total: latest.total, shares: sharesOf(latest), scale: latest.scale, model: latest.model }
}

export interface ToolStat {
  readonly name: string
  readonly calls: number
  readonly errors: number
  readonly ms: number
  readonly maxMs: number
  /** Estimated tokens the tool's results added to the context. */
  readonly outputTokens: number
}

export const toolStats = (turns: readonly Turn[]): ToolStat[] => {
  const stats = new Map<string, { calls: number; errors: number; ms: number; maxMs: number; chars: number }>()
  for (const turn of turns)
    for (const step of turn.steps)
      for (const tool of step.tools) {
        const stat = stats.get(tool.name) ?? { calls: 0, errors: 0, ms: 0, maxMs: 0, chars: 0 }
        stat.calls += 1
        if (tool.status === "error") stat.errors += 1
        stat.ms += tool.ms
        stat.maxMs = Math.max(stat.maxMs, tool.ms)
        stat.chars += tool.outputChars
        stats.set(tool.name, stat)
      }
  return [...stats].map(([name, s]) => ({
    name,
    calls: s.calls,
    errors: s.errors,
    ms: s.ms,
    maxMs: s.maxMs,
    outputTokens: estimateTokens(s.chars),
  }))
}
