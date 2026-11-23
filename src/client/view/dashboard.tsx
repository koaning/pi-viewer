import { createMemo, createSignal, For, Match, Show, Switch, type Accessor, type JSX } from "solid-js"
import * as f from "../../format"
import { contextOf, totalOf, type ToolStat, type Turn } from "../../model"
import type { Cost } from "../../pricing"
import type { Dashboard as Data, SessionView } from "../store"
import { grouped, TIME, paletteOf, type Palette } from "./buckets"
import { ContextChart, Key, Legend, StackBar, type Segment } from "./charts"
import { tween } from "./motion"
import { createTip, type Tip } from "./tip"
import { TurnTrace } from "./trace"

export interface Props {
  readonly dashboard: Accessor<Data>
  /** The name of the model whose prices stand in for unpriced ones. */
  readonly fallbackName: Accessor<string | undefined>
  /** The control that picks it, for the header. */
  readonly pricing?: JSX.Element
  readonly mode: Accessor<"light" | "dark">
}

export function Dashboard(props: Props) {
  const tip = createTip()
  const dashboard = props.dashboard
  const root = () => dashboard().root
  const palette = createMemo(() => {
    const keys = new Set<string>()
    for (const point of dashboard().timeline.points) for (const key of Object.keys(point.parts)) keys.add(key)
    return paletteOf(dashboard().breakdown, keys)
  })

  // The turns are an accordion: the latest is open unless you fold it, any other opens when you click it. A new turn
  // takes over as the open one, and the one before it folds unless you opened it yourself.
  const [toggled, setToggled] = createSignal<ReadonlyMap<string, boolean>>(new Map())
  const latest = () => root()?.turns[root()!.turns.length - 1]?.id
  const isOpen = (id: string) => toggled().get(id) ?? id === latest()
  const toggle = (id: string) => setToggled((map) => new Map(map).set(id, !isOpen(id)))
  // One picked span (a request, tool call or marker), shared by the chart and every open trace.
  const [span, setSpan] = createSignal<string>()
  let rootEl: HTMLElement | undefined
  const pickStep = (stepId: string) => {
    const hit = dashboard().steps.get(stepId)
    if (!hit) return
    setToggled((map) => new Map(map).set(hit.turn.id, true))
    setSpan(stepId)
    requestAnimationFrame(() =>
      rootEl?.querySelector(`[data-turn="${hit.turn.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" }),
    )
  }

  return (
    <div
      class="ocv-root"
      data-mode={props.mode()}
      ref={(el) => {
        rootEl = el
        tip.ref(el)
      }}
    >
      <header class="ocv-header">
        <div class="ocv-title">
          <Show when={root()?.running} fallback={<span class="ocv-status" />}>
            <span class="ocv-status ocv-status-live" title="Running" />
          </Show>
          <span class="ocv-title-text" title={root()?.title}>
            {f.firstLine(root()?.title ?? "", 90) || "Session"}
          </span>
          <Show when={dashboard().loading}>
            <span class="ocv-muted ocv-small">loading…</span>
          </Show>
        </div>
        <div class="ocv-actions">{props.pricing}</div>
      </header>
      <Show when={dashboard().gone}>
        <div class="ocv-empty">This session's file is gone.</div>
      </Show>
      <Show when={dashboard().abandoned > 0}>
        <div class="ocv-muted ocv-small ocv-note">
          Showing the active branch; {dashboard().abandoned} other branch{dashboard().abandoned === 1 ? "" : "es"} in this session's tree{" "}
          {dashboard().abandoned === 1 ? "isn't" : "aren't"} counted.
        </div>
      </Show>

      <Show when={root()} fallback={<Show when={!dashboard().loading && !dashboard().gone}><div class="ocv-empty">Nothing in this session yet.</div></Show>}>
        {(view) => (
          <>
            <ContextPanel data={dashboard()} palette={palette()} tip={tip} />
            <Strip view={view()} fallbackName={props.fallbackName()} />
            <RequestsSection data={dashboard()} view={view()} palette={palette()} tip={tip} selected={span()} onSelect={pickStep} />
            <TurnsSection
              view={view()}
              dashboard={dashboard()}
              palette={palette()}
              tip={tip}
              isOpen={isOpen}
              onToggle={toggle}
              span={span()}
              onSpan={setSpan}
            />
            <ToolsSection tools={dashboard().tools} />
          </>
        )}
      </Show>
      <tip.View />
    </div>
  )
}

function Tile(props: { readonly label: string; readonly value: JSX.Element; readonly children?: JSX.Element; readonly title?: string }) {
  return (
    <div class="ocv-tile" title={props.title}>
      <div class="ocv-tile-label">{props.label}</div>
      <div class="ocv-tile-value">{props.value}</div>
      <div class="ocv-tile-sub">{props.children}</div>
    </div>
  )
}

/** The session's other numbers, in a compact row under the context panel. */
function Strip(props: { readonly view: SessionView; readonly fallbackName?: string }) {
  const totals = () => props.view.totals
  const own = () => props.view.totals
  const sent = () => contextOf(totals().usage)
  const cached = () => (sent() > 0 ? totals().usage.cacheRead / sent() : 0)
  const active = () => props.view.turns.reduce((sum, t) => sum + t.ms, 0)
  return (
    <section class="ocv-strip">
      <Tile
        label="Active time"
        value={f.duration(active())}
        title={`Each turn from its prompt to its last step, added up. ${f.duration(own().wallMs)} from the first message to the last.`}
      >
        model {f.duration(own().modelMs)} · tools {f.duration(own().toolMs)}
      </Tile>
      <Tile
        label="Tokens processed"
        value={f.tokens(totalOf(totals().usage))}
        title={`Every request resends the context, so this grows much faster than the context. Summed over all requests: ${f.tokens(sent())} sent (${f.tokens(totals().usage.input + totals().usage.cacheWrite)} new, ${f.tokens(totals().usage.cacheRead)} cached) and ${f.tokens(totals().usage.output + totals().usage.reasoning)} generated.`}
      >
        <span class="ocv-nowrap">{f.tokens(sent())} sent</span>{" "}
        <span class="ocv-nowrap">({Math.round(cached() * 100)}% cached)</span>{" "}
        <span class="ocv-nowrap">· {f.tokens(totals().usage.output + totals().usage.reasoning)} out</span>
      </Tile>
      <Tile label="Cost" value={f.cost(totals().cost)} title={f.costNote(totals().cost, props.fallbackName)}>
        <CostKind cost={totals().cost} />
      </Tile>
      <Tile label="Activity" value={`${own().turns} turn${own().turns === 1 ? "" : "s"}`}>
        {totals().steps} req · {totals().toolCalls} tools
      </Tile>
    </section>
  )
}

function CostKind(props: { readonly cost: Cost }) {
  return (
    <Switch>
      <Match when={props.cost.kind === "reported"}>as pi recorded it{props.cost.partial ? ", some unpriced" : ""}</Match>
      <Match when={props.cost.kind === "estimated"}>at catalog prices</Match>
      <Match when={props.cost.kind === "fallback"}>at fallback prices</Match>
      <Match when={props.cost.kind === "none"}>no price</Match>
    </Switch>
  )
}

/** How far the character-count estimate may miss the measured total before the panel says to read the shares loosely. */
const ESTIMATE_OFF = 0.25

/** What fills the context now, against the model's window: the headline share, one bar, a row per category. */
function ContextPanel(props: { readonly data: Data; readonly palette: Palette; readonly tip: Tip }) {
  const latest = () => props.data.timeline.points[props.data.timeline.points.length - 1]
  const segments = createMemo((): Segment[] => {
    const point = latest()
    if (!point) return []
    return [...grouped(point.parts, props.palette)]
      .filter(([, value]) => value >= 1)
      .sort((a, b) => b[1] - a[1])
      .map(([key, value]) => ({ key, value, ...props.palette.meta(key) }))
  })
  const total = () => props.data.breakdown?.total ?? 0
  const limit = () => props.data.limit
  const ratio = () => (limit() ? total() / limit()! : 0)
  const shownTotal = tween(total)
  const shownShare = tween(() => ratio() * 100)
  return (
    <section class="ocv-section ocv-ctx">
      <h3>
        Context
        <Show when={props.data.model}>
          <span class="ocv-muted ocv-small"> · {props.data.model!.name}</span>
        </Show>
      </h3>
      <Show when={props.data.breakdown} fallback={<div class="ocv-muted">No request has reported tokens yet.</div>}>
        {(breakdown) => (
          <>
            <div class="ocv-ctx-head" classList={{ "ocv-ctx-warn": ratio() >= 0.8 }}>
              <Show
                when={limit()}
                fallback={<span class="ocv-ctx-big ocv-num">{f.tokens(shownTotal())} in context</span>}
              >
                <span class="ocv-ctx-big ocv-num">{f.share(shownShare(), 100)} used</span>
                <span class="ocv-ctx-of ocv-num">
                  {f.tokens(shownTotal())} / {f.tokens(limit()!)}
                </span>
              </Show>
            </div>
            <StackBar segments={segments()} max={limit()} track tip={props.tip} height={6} />
            <Legend
              segments={segments()}
              total={limit() ?? breakdown().total}
              free={limit() ? Math.max(0, limit()! - total()) : undefined}
            />
            <Show when={ratio() >= 0.8}>
              <div class="ocv-small ocv-warn-text">Near the model's context limit</div>
            </Show>
            <Show when={Math.abs(breakdown().scale - 1) > ESTIMATE_OFF}>
              <div class="ocv-muted ocv-small ocv-note">
                Estimated shares of the latest request. The character-count estimate was off by{" "}
                {Math.round(Math.abs(breakdown().scale - 1) * 100)}%, so read them loosely.
              </div>
            </Show>
          </>
        )}
      </Show>
    </section>
  )
}

function RequestsSection(props: {
  readonly data: Data
  readonly view: SessionView
  readonly palette: Palette
  readonly tip: Tip
  readonly selected?: string
  readonly onSelect: (step: string) => void
}) {
  const legend = () => props.palette.order.map((key) => props.palette.meta(key))
  // The chart has the session's requests; model work its tools did (subagents, say) costs on top.
  const toolCost = () => props.view.toolCost.value
  return (
    <Show when={props.data.timeline.points.length > 0}>
      <section class="ocv-section">
        <h3>
          Every request
          <span class="ocv-muted ocv-small">
            {" "}
            · what its context held
            <Show when={props.data.timeline.compactions.length > 0}> · dashed: compaction</Show>
          </span>
        </h3>
        <Key items={legend()} />
        <ContextChart
          points={props.data.timeline.points}
          compactions={props.data.timeline.compactions}
          palette={props.palette}
          limit={props.data.limit}
          tip={props.tip}
          step={(id) => props.data.steps.get(id)?.step}
          turn={(id) => props.data.steps.get(id)?.turn}
          selected={props.selected}
          onSelect={(point) => props.onSelect(point.step)}
        />
        <Show when={toolCost() > 0.00005}>
          <div class="ocv-muted ocv-small ocv-note">
            Plus {f.usd(toolCost())} that tools spent on model work of their own (subagents, say), inside their calls.
          </div>
        </Show>
      </section>
    </Show>
  )
}

const WAITING = { label: "Waiting", color: TIME.other.color }

const timeSegments = (t: Turn): Segment[] => {
  const thinking = t.steps.reduce((sum, s) => sum + s.thinkingMs, 0)
  return [
    { key: "thinking", label: TIME.thinking.label, value: thinking, color: TIME.thinking.color },
    { key: "model", label: TIME.model.label, value: Math.max(0, t.modelMs - thinking), color: TIME.model.color },
    { key: "tools", label: TIME.tools.label, value: t.toolMs, color: TIME.tools.color },
    { key: "other", label: TIME.other.label, value: t.otherMs, color: TIME.other.color },
  ]
}

/**
 * The turns, newest first, as an accordion: each row is a turn's prompt, time split and numbers, and opens into its
 * trace. The latest is open; click any other to open it too.
 */
function TurnsSection(props: {
  readonly view: SessionView
  readonly dashboard: Data
  readonly palette: Palette
  readonly tip: Tip
  readonly isOpen: (id: string) => boolean
  readonly onToggle: (id: string) => void
  readonly span?: string
  readonly onSpan: (id: string | undefined) => void
}) {
  // Keyed by id: the dashboard rebuilds its turns on every update, and a row should keep its node (so its bar eases)
  // and only a turn that just started should slide in. A batch of new ids (the first paint, another session) doesn't.
  const byId = createMemo(() => new Map(props.view.turns.map((t) => [t.id, t])))
  const newest = () => props.view.turns.map((t) => t.id).reverse()
  const seen = new Set<string>()
  let first = true
  const fresh = createMemo(() => {
    const added = props.view.turns.map((t) => t.id).filter((id) => !seen.has(id))
    for (const id of added) seen.add(id)
    const out = first || added.length > 2 ? new Set<string>() : new Set(added)
    first = false
    return out
  })
  const longest = () => props.view.turns.reduce((max, t) => Math.max(max, t.ms), 1)
  return (
    <section class="ocv-section">
      <h3>
        Turns
        <span class="ocv-muted ocv-small"> · newest first, click one to open its trace</span>
      </h3>
      <Key items={[TIME.thinking, TIME.model, TIME.tools, WAITING]} />
      <ol class="ocv-turns">
        <For each={newest()}>
          {(id) => {
            const enter = fresh().has(id)
            return (
              <Show when={byId().get(id)}>
                {(turn) => (
                  <TurnRow
                    turn={turn()}
                    enter={enter}
                    max={longest()}
                    tip={props.tip}
                    open={props.isOpen(id)}
                    onToggle={() => props.onToggle(id)}
                  >
                    <TurnTrace
                      turn={turn()}
                      dashboard={props.dashboard}
                      palette={props.palette}
                      now={turn().end}
                      tip={props.tip}
                      selected={props.span}
                      onSelect={props.onSpan}
                    />
                  </TurnRow>
                )}
              </Show>
            )
          }}
        </For>
      </ol>
    </section>
  )
}

function TurnRow(props: {
  readonly turn: Turn
  readonly enter: boolean
  readonly max: number
  readonly tip: Tip
  readonly open: boolean
  readonly onToggle: () => void
  /** The trace, shown while open. */
  readonly children: JSX.Element
}) {
  const prompt = () => f.firstLine(props.turn.prompt) || (props.turn.prompt ? f.firstLine(props.turn.prompt.replace(/<[^>]+>/g, " ")) : "(before the first prompt)")
  return (
    <li
      class="ocv-turn"
      data-turn={props.turn.id}
      classList={{ "ocv-open": props.open, "ocv-running": props.turn.running, "ocv-enter": props.enter }}
      // Once played, so the row doesn't replay it when the list moves it.
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) event.currentTarget.classList.remove("ocv-enter")
      }}
    >
      <button class="ocv-turn-head" onClick={props.onToggle} aria-expanded={props.open}>
        <div class="ocv-row">
          <span class="ocv-turn-chevron" aria-hidden="true" />
          <span class="ocv-turn-index">#{props.turn.index + 1}</span>
          <span class="ocv-turn-prompt">{prompt()}</span>
          <span class="ocv-num" classList={{ "ocv-live": props.turn.running }}>
            {f.duration(props.turn.ms)}
          </span>
        </div>
        <StackBar segments={timeSegments(props.turn)} max={props.max} tip={props.tip} format={f.duration} height={6} />
        <div class="ocv-row ocv-muted ocv-small">
          <span>{f.clock(props.turn.start)}</span>
          <span>
            {props.turn.steps.length} req · {props.turn.toolCalls} tools
          </span>
          <span>{f.tokens(totalOf(props.turn.usage))} tok</span>
          <span>peak {f.tokens(props.turn.peakContext)} ctx</span>
          <span title={f.costNote(props.turn.cost)}>{f.cost(props.turn.cost)}</span>
          <Show when={props.turn.running}>
            <span class="ocv-live">running</span>
          </Show>
        </div>
      </button>
      <Show when={props.open}>
        <div class="ocv-turn-body ocv-fade-in">{props.children}</div>
      </Show>
    </li>
  )
}

type SortKey = "ms" | "calls" | "outputTokens"

function ToolsSection(props: { readonly tools: readonly ToolStat[] }) {
  const [sort, setSort] = createSignal<SortKey>("ms")
  const sorted = () => [...props.tools].sort((a, b) => b[sort()] - a[sort()])
  const Head = (p: { readonly key: SortKey; readonly label: string; readonly title: string }) => (
    <th class="ocv-num" title={p.title}>
      <button class="ocv-sort" classList={{ "ocv-sorted": sort() === p.key }} onClick={() => setSort(p.key)}>
        {p.label}
        {sort() === p.key ? " ↓" : ""}
      </button>
    </th>
  )
  return (
    <Show when={props.tools.length > 0}>
      <section class="ocv-section">
        <h3>Tools</h3>
        <table class="ocv-table">
          <thead>
            <tr>
              <th>Tool</th>
              <Head key="calls" label="Calls" title="Calls on the active branch" />
              <Head key="ms" label="Time" title="Total execution time" />
              <th class="ocv-num" title="Longest single call">Max</th>
              <Head key="outputTokens" label="Output" title="Estimated tokens of results returned to the model" />
            </tr>
          </thead>
          <tbody>
            <For each={sorted()}>
              {(tool) => (
                <tr>
                  <td>
                    {tool.name}
                    <Show when={tool.errors > 0}>
                      <span class="ocv-error-text ocv-small"> · {tool.errors} failed</span>
                    </Show>
                  </td>
                  <td class="ocv-num">{tool.calls}</td>
                  <td class="ocv-num">{f.duration(tool.ms)}</td>
                  <td class="ocv-num ocv-muted">{f.duration(tool.maxMs)}</td>
                  <td class="ocv-num">~{f.tokens(tool.outputTokens)}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </section>
    </Show>
  )
}
