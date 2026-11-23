import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js"
import type { CatalogModel, SessionEvent, SessionSummary } from "../api"
import {
  contextBreakdown,
  contextTimeline,
  toolStats,
  totalsOf,
  turnsOf,
  type Breakdown,
  type Pricing,
  type Step,
  type Timeline,
  type ToolStat,
  type Totals,
  type Turn,
} from "../model"
import { activeBranch } from "../pi/branch"
import { normalize } from "../pi/normalize"
import type { PiEntry, PiHeader } from "../pi/types"
import { sumCosts, type Cost } from "../pricing"
import { fallbackCost, lookup, modelInfo } from "./catalog"

/** A session's numbers. */
export interface SessionView {
  readonly id: string
  readonly title: string
  readonly running: boolean
  readonly turns: readonly Turn[]
  readonly totals: Totals
  /** What its tools spent on model work of their own; part of `totals.cost`. */
  readonly toolCost: Cost
}

export interface Dashboard {
  readonly root: SessionView | undefined
  readonly summary: SessionSummary | undefined
  readonly header: PiHeader | undefined
  readonly breakdown: Breakdown | undefined
  /** Every request on the active branch: what its context held and what it produced. */
  readonly timeline: Timeline
  /** Every step by id, with the turn it belongs to. */
  readonly steps: ReadonlyMap<string, { readonly step: Step; readonly turn: Turn }>
  readonly tools: readonly ToolStat[]
  /** The context window of the model the latest request went to. */
  readonly limit: number | undefined
  readonly model: CatalogModel | undefined
  /** Branches of the session tree other than the one shown. */
  readonly abandoned: number
  readonly loading: boolean
  /** The file was deleted. */
  readonly gone: boolean
}

/** The tab is showing; the clock stops while it isn't. */
const [visible, setVisible] = createSignal(typeof document === "undefined" || document.visibilityState !== "hidden")
if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => setVisible(document.visibilityState !== "hidden"))

/**
 * Follows a session's file through the server: a snapshot of its entries, then each batch pi appends. Everything else
 * is computed here, from the active branch.
 */
export function createSessionStore(id: Accessor<string>) {
  const [entries, setEntries] = createSignal<readonly PiEntry[]>([])
  const [header, setHeader] = createSignal<PiHeader>()
  const [summary, setSummary] = createSignal<SessionSummary>()
  const [loading, setLoading] = createSignal(true)
  const [gone, setGone] = createSignal(false)

  createEffect(() => {
    const sessionId = id()
    setEntries([])
    setHeader(undefined)
    setSummary(undefined)
    setLoading(true)
    setGone(false)
    const source = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/stream`)
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as SessionEvent
      switch (event.type) {
        case "snapshot":
          setHeader(event.header)
          setSummary(event.summary)
          setEntries(event.entries)
          setLoading(false)
          break
        case "append":
          setEntries((list) => [...list, ...event.entries])
          break
        case "summary":
          setSummary(event.summary)
          break
        case "gone":
          setGone(true)
          source.close()
          break
      }
    }
    // A 404 (no such session) closes the stream; anything else, EventSource retries on its own.
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) {
        setLoading(false)
        setGone(true)
      }
    }
    onCleanup(() => source.close())
  })

  return { entries, header, summary, loading, gone }
}

export type SessionStore = ReturnType<typeof createSessionStore>

/** The dashboard's numbers for a session, recomputed as it grows; a clock ticks them while it runs. */
export function createDashboard(store: SessionStore): Accessor<Dashboard> {
  const running = () => store.summary()?.running ?? false
  const branch = createMemo(() => activeBranch(store.entries()))
  const transcript = createMemo(() => normalize(branch().entries, { running: running() }))
  const pricing = createMemo((): Pricing => ({ lookup, fallback: fallbackCost() }))

  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    if (!running() || !visible()) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })

  // What doesn't depend on the clock, apart, so the second-by-second ticks only redo the turns.
  const timeline = createMemo(() => contextTimeline(transcript().messages))
  const breakdown = createMemo(() => contextBreakdown(transcript().messages, timeline()))

  return createMemo((): Dashboard => {
    const live = running()
    const turns = turnsOf(transcript().messages, { now: live ? now() : Date.now(), running: live, pricing: pricing() })
    const summary = store.summary()
    const steps = new Map<string, { step: Step; turn: Turn }>()
    for (const turn of turns) for (const step of turn.steps) steps.set(step.id, { step, turn })
    const latest = timeline().points[timeline().points.length - 1]?.model ?? transcript().model
    const model = modelInfo(latest, true)
    const firstPrompt = turns.find((t) => t.prompt)?.prompt
    return {
      root: store.entries().length
        ? {
            id: summary?.id ?? "",
            title: summary?.name || firstPrompt || "",
            running: live,
            turns,
            totals: totalsOf(turns),
            toolCost: sumCosts(turns.map((t) => t.toolCost)),
          }
        : undefined,
      summary,
      header: store.header(),
      breakdown: breakdown(),
      timeline: timeline(),
      steps,
      tools: toolStats(turns),
      limit: model?.contextWindow,
      model,
      abandoned: branch().abandoned,
      loading: store.loading(),
      gone: store.gone(),
    }
  })
}
