// The transcript shape model.ts works on. pi's session entries are turned into these by `pi/normalize.ts`: one
// message per request (with its tool calls and their results folded in), one per prompt, and one per note in between.
// Keeping the model on this shape keeps it free of pi's file format, and lets tests build transcripts directly.

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export interface ModelRef {
  readonly id: string
  readonly providerID: string
  readonly variant?: string
}

/** Rates in USD per million tokens. A `tier` entry applies from that much context on. */
export interface ModelCost {
  readonly input: number
  readonly output: number
  readonly cache: { readonly read: number; readonly write: number }
  readonly tier?: { readonly type: "context"; readonly size: number }
}

/** A request's tokens. `output` leaves out `reasoning`, which is counted apart. `input` is uncached input. */
export interface TokenUsageInfo {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cache: { readonly read: number; readonly write: number }
}

/** What a request cost, by what it paid for, as pi computed it. */
export interface CostBreakdown {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly total: number
}

export interface TextContent {
  readonly type: "text"
  readonly text: string
}

export type ToolState =
  | { readonly status: "running"; readonly input: JsonValue }
  | { readonly status: "completed"; readonly input: JsonValue; readonly content: readonly TextContent[] }
  | {
      readonly status: "error"
      readonly input: JsonValue
      readonly content?: readonly TextContent[]
      readonly error: { readonly message: string }
    }

export interface AssistantTool {
  readonly type: "tool"
  readonly id: string
  readonly name: string
  /** `created`: the model emitted it; `ran`: the tool started; `completed`: its result came back. */
  readonly time: { readonly created: number; readonly ran?: number; readonly completed?: number }
  readonly state: ToolState
  /** Usage of model work the tool did itself (e.g. a subagent), which pi counts toward the session. */
  readonly usage?: TokenUsageInfo
  readonly cost?: CostBreakdown
}

export type AssistantPart =
  | TextContent
  | { readonly type: "reasoning"; readonly text: string; readonly time?: { readonly created: number; readonly completed?: number } }
  | AssistantTool

export interface AssistantMessage {
  readonly id: string
  readonly type: "assistant"
  readonly agent: string
  readonly model: ModelRef
  /** `created`: the request went out; `streamed`: the model finished; `completed`: its tools finished too. */
  readonly time: { readonly created: number; readonly streamed?: number; readonly completed?: number }
  readonly finish?: string
  /** What pi computed the request cost; undefined for a request still in flight. */
  readonly cost?: CostBreakdown
  readonly tokens?: TokenUsageInfo
  readonly error?: { readonly message: string }
  readonly content: readonly AssistantPart[]
  /** Stands in for a request pi hasn't written yet (it writes each one once the model is done). */
  readonly pending?: boolean
}

export interface UserMessage {
  readonly id: string
  readonly type: "user"
  readonly time: { readonly created: number }
  readonly text: string
  /** Attached images. */
  readonly files?: number
}

export interface CompactionMessage {
  readonly id: string
  readonly type: "compaction"
  readonly time: { readonly created: number }
  readonly summary: string
  readonly tokensBefore?: number
  /** The first message kept in the context after it; the ones before were summarized away. */
  readonly keepFrom?: string
  readonly model?: ModelRef
  readonly tokens?: TokenUsageInfo
  readonly cost?: CostBreakdown
}

/** A summary of a branch left behind with /tree, which the context carries from here on. */
export interface BranchMessage {
  readonly id: string
  readonly type: "branch"
  readonly time: { readonly created: number }
  readonly summary: string
  readonly model?: ModelRef
  readonly tokens?: TokenUsageInfo
  readonly cost?: CostBreakdown
}

/** A `!command` the user ran in pi. */
export interface ShellMessage {
  readonly id: string
  readonly type: "shell"
  readonly time: { readonly created: number }
  readonly command: string
  readonly output: string
  /** `!!command`: run, but kept out of the model's context. */
  readonly excluded: boolean
}

/** A system prompt or tool loadout change. The first one, before any request, is what the anchor measures. */
export interface SystemMessage {
  readonly id: string
  readonly type: "system"
  readonly time: { readonly created: number }
  readonly text: string
  readonly description?: string
  /** Declared before any request: the prompt the first request measured. */
  readonly initial?: boolean
}

/** Context an extension put in front of the model. */
export interface SyntheticMessage {
  readonly id: string
  readonly type: "synthetic"
  readonly time: { readonly created: number }
  readonly text: string
  readonly description?: string
}

/** Model work outside any request, e.g. cache warming. Counts toward cost, not context. */
export interface UsageMessage {
  readonly id: string
  readonly type: "usage"
  readonly time: { readonly created: number }
  readonly kind: string
  readonly model?: ModelRef
  readonly tokens: TokenUsageInfo
  readonly cost?: CostBreakdown
}

export type Message =
  | UserMessage
  | AssistantMessage
  | CompactionMessage
  | BranchMessage
  | ShellMessage
  | SystemMessage
  | SyntheticMessage
  | UsageMessage
