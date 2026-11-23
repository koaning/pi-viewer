import type { Breakdown } from "../../model"

// Categorical slots (validated palette, see style.css). Color follows the entity: what a request produced keeps its
// color once it sits in the context (reasoning is violet in both), and a tool keeps its slot everywhere.
export const S = (n: number) => `var(--ocv-s${n})`
export const NEUTRAL = "var(--ocv-neutral)"
export const NEUTRAL_2 = "var(--ocv-neutral-2)"

export const TIME = {
  thinking: { label: "Thinking", color: S(7) },
  model: { label: "Generating", color: S(1) },
  tools: { label: "Tools", color: S(2) },
  other: { label: "Waiting / other", color: NEUTRAL },
}

export const PRODUCED = {
  reasoning: { label: "Thinking", color: S(7) },
  text: { label: "Text", color: S(3) },
  calls: { label: "Tool call args", color: S(4) },
}

/** What a request's cost paid for. Cache reads are muted: the cheap part, however many tokens. */
export const COST = {
  cacheRead: { label: "Cache reads", color: NEUTRAL },
  input: { label: "New input", color: S(1) },
  cacheWrite: { label: "Cache writes", color: S(8) },
  output: { label: "Output + thinking", color: S(3) },
}

export interface Meta {
  readonly label: string
  readonly color: string
  readonly detail?: string
}

const FIXED: Record<string, Meta> = {
  system: { label: "System / tools", color: NEUTRAL, detail: "System prompt and tool definitions, measured from the first request" },
  summary: { label: "Compaction summary", color: S(8), detail: "What replaced the history before the last compaction" },
  user: { label: "Your messages", color: S(1), detail: "Prompts, images, ! commands and extension messages" },
  assistant: { label: "Assistant text", color: S(3), detail: "The model's replies" },
  reasoning: { label: "Reasoning", color: S(7), detail: "Thinking the transcript kept" },
  calls: { label: "Tool call inputs", color: S(4), detail: "Arguments the model wrote for its tool calls" },
}
const TOOL_SLOTS = [S(2), S(5), S(6)]
const OTHER_TOOLS = "tools:other"

/**
 * The categories of the context, as the composition bar and the timeline show them: the fixed buckets, the three tools
 * whose results take the most room now with a slot each, and every other tool's results together.
 */
export interface Palette {
  /** The category a part's key falls in. */
  readonly group: (key: string) => string
  readonly meta: (group: string) => Meta
  /** Categories bottom to top in a stack: the system share as the baseline, then what the conversation adds. */
  readonly order: readonly string[]
}

export const paletteOf = (breakdown: Breakdown | undefined, keys: Iterable<string>): Palette => {
  const top = (breakdown?.shares ?? [])
    .filter((s) => s.bucket.kind === "tool")
    .slice(0, TOOL_SLOTS.length)
    .map((s) => (s.bucket.kind === "tool" ? s.bucket.name : ""))
  const group = (key: string) => {
    if (!key.startsWith("tool:")) return key
    return top.includes(key.slice(5)) ? key : OTHER_TOOLS
  }
  const meta = (g: string): Meta => {
    if (FIXED[g]) return FIXED[g]
    if (g === OTHER_TOOLS) return { label: "Other tool results", color: NEUTRAL_2 }
    const name = g.slice(5)
    return { label: `${name} results`, color: TOOL_SLOTS[top.indexOf(name)] ?? NEUTRAL_2, detail: "What this tool returned to the model" }
  }
  const present = new Set([...keys].map(group))
  const order = [
    ...["system", "summary", "user", "assistant", "reasoning", "calls"].filter((k) => present.has(k)),
    ...top.map((name) => `tool:${name}`).filter((k) => present.has(k)),
    ...(present.has(OTHER_TOOLS) ? [OTHER_TOOLS] : []),
  ]
  return { group, meta, order }
}

/** A point's parts summed by category. */
export const grouped = (parts: Readonly<Record<string, number>>, palette: Palette): Map<string, number> => {
  const out = new Map<string, number>()
  for (const [key, value] of Object.entries(parts)) {
    const g = palette.group(key)
    out.set(g, (out.get(g) ?? 0) + value)
  }
  return out
}
