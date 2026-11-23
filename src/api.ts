// What the CLI's server and the browser say to each other.

import type { InFlight } from "./pi/normalize"
import type { PiEntry, PiHeader } from "./pi/types"

export interface SessionSummary {
  /** The session's id, as in its file name. */
  readonly id: string
  readonly path: string
  readonly cwd: string
  /** Set with /name in pi. */
  readonly name?: string
  readonly firstPrompt?: string
  /** When the session started. */
  readonly created: number
  /** When its file last changed. */
  readonly modified: number
  /** The file changed in the last few minutes. */
  readonly live: boolean
  /** It is waiting on the model or its tools, and recently wrote something. */
  readonly running: boolean
  readonly inFlight: InFlight
  /** The model of its latest request. */
  readonly model?: { readonly provider: string; readonly id: string }
  /** The context its latest request sent, in tokens. */
  readonly context: number
  /** What pi recorded it cost, in USD, over the whole file. */
  readonly cost: number
  readonly prompts: number
  readonly requests: number
  /** The session it was forked or cloned from. */
  readonly parentSession?: string
}

/** A model from pi's catalogs: its window and its prices, in USD per million tokens. */
export interface CatalogModel {
  readonly provider: string
  readonly id: string
  readonly name: string
  readonly contextWindow?: number
  readonly cost?: readonly import("./messages").ModelCost[]
}

/** Events on `/api/sessions/:id/stream`. */
export type SessionEvent =
  | { readonly type: "snapshot"; readonly summary: SessionSummary; readonly header?: PiHeader; readonly entries: readonly PiEntry[] }
  | { readonly type: "append"; readonly entries: readonly PiEntry[] }
  | { readonly type: "summary"; readonly summary: SessionSummary }
  | { readonly type: "gone" }

/** How long since its last write a session counts as live. */
export const LIVE_MS = 15 * 60_000
/** How long a session waiting on its model or tools counts as running without writing anything. */
export const RUNNING_MS = 10 * 60_000
