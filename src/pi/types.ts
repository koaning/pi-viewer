// pi's session file entries, as far as the dashboard reads them. See pi's docs/session-format.md and
// docs/message-types.md. Everything is optional-ish on purpose: files from older pi versions lack newer fields, and
// extensions can add roles and entry types we don't know.

export interface PiUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cacheWrite1h?: number
  /** Already included in `output`. */
  reasoning?: number
  totalTokens?: number
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; totalFromProvider?: boolean }
}

export type PiContent =
  | { type: "text"; text: string }
  | { type: "image"; data?: string; mimeType?: string }
  | { type: "thinking"; thinking: string; redacted?: boolean }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }

export type PiMessage =
  | { role: "system"; content: string | PiContent[]; sections?: Record<string, string | null>; toolsAdded?: { name: string }[]; toolsRemoved?: { name: string }[]; timestamp: number }
  | { role: "user"; content: string | PiContent[]; timestamp: number }
  | {
      role: "assistant"
      content: PiContent[]
      provider: string
      model: string
      usage?: PiUsage
      stopReason?: string
      errorMessage?: string
      thinkingLevel?: string
      durationMs?: number
      timestamp: number
    }
  | {
      role: "toolResult"
      toolCallId: string
      toolName: string
      content: PiContent[]
      isError?: boolean
      usage?: PiUsage
      durationMs?: number
      timestamp: number
    }
  | { role: "bashExecution"; command: string; output?: string; exitCode?: number; excludeFromContext?: boolean; timestamp: number }
  | { role: "custom"; customType?: string; content: string | PiContent[]; display?: boolean; timestamp: number }
  | { role: "branchSummary"; summary: string; timestamp: number }
  | { role: "compactionSummary"; summary: string; tokensBefore?: number; timestamp: number }

export interface PiHeader {
  type: "session"
  version?: number
  id: string
  timestamp: string
  cwd?: string
  parentSession?: string
}

interface Base {
  id: string
  parentId: string | null
  timestamp: string
}

export type PiEntry =
  | (Base & { type: "message"; message: PiMessage })
  | (Base & { type: "model_change"; provider: string; modelId: string })
  | (Base & { type: "thinking_level_change"; thinkingLevel: string })
  | (Base & {
      type: "compaction"
      summary: string
      firstKeptEntryId?: string
      tokensBefore?: number
      usage?: PiUsage
      provider?: string
      model?: string
    })
  | (Base & { type: "branch_summary"; fromId?: string; summary: string; usage?: PiUsage; provider?: string; model?: string })
  | (Base & { type: "usage"; kind?: string; provider?: string; model?: string; usage: PiUsage })
  | (Base & { type: "custom_message"; customType?: string; content: string | PiContent[]; display?: boolean })
  | (Base & { type: "custom"; customType?: string; data?: unknown })
  | (Base & { type: "label"; targetId: string; label?: string })
  | (Base & { type: "session_info"; name?: string })
  | (Base & { type: "context_edit"; targetId: string })

/** Any line of a session file. */
export type PiLine = PiHeader | PiEntry
