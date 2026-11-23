import { createMemo, createSignal, For, Show, type JSX } from "solid-js"
import * as f from "../../format"
import type { ContextPoint, Step, Turn } from "../../model"
import { SPLIT_KEYS, type Cost } from "../../pricing"
import { COST, grouped, PRODUCED, type Palette } from "./buckets"
import type { Tip } from "./tip"

export interface Segment {
  readonly key: string
  readonly label: string
  readonly value: number
  /** A CSS color, usually one of the `--ocv-s*` slots. */
  readonly color: string
  readonly detail?: string
}

const NONE: Segment = { key: "", label: "", value: 0, color: "transparent" }

/**
 * A part's `flex-grow`: its share of the whole, in percent. Raw values won't do: when the grow factors of a flex line
 * add up to less than 1 (a request's cost in dollars), the parts fill only that fraction of the line.
 */
const grow = (value: number, total: number) => (total > 0 ? (value / total) * 100 : 0)

/**
 * Segments keyed by `key`, so a list keeps its DOM nodes while the dashboard recomputes (it builds new objects every
 * time) and CSS transitions get to run.
 */
const keyed = (segments: () => readonly Segment[]) => {
  const byKey = createMemo(() => new Map(segments().map((s) => [s.key, s])))
  return { keys: () => segments().map((s) => s.key), get: (key: string) => byKey().get(key) ?? NONE }
}

/**
 * A horizontal bar split into parts, 2px apart. `max` scales it against something bigger (other rows in a list, or a
 * context window); without it the bar is full width. `track` shows the room up to `max`.
 */
export function StackBar(props: {
  readonly segments: readonly Segment[]
  readonly max?: number
  readonly tip?: Tip
  readonly height?: number
  readonly track?: boolean
  readonly format?: (value: number) => string
}) {
  const visible = () => props.segments.filter((s) => s.value > 0)
  const list = keyed(visible)
  const total = () => props.segments.reduce((sum, s) => sum + s.value, 0)
  const width = () => (props.max ? Math.min(100, Math.max(0.5, (total() / props.max) * 100)) : 100)
  const format = (value: number) => (props.format ?? f.tokens)(value)
  return (
    <div class="ocv-stack" classList={{ "ocv-stack-track": props.track }} style={{ height: `${props.height ?? 10}px` }}>
      <div class="ocv-stack-fill" style={{ width: `${width()}%` }}>
        <For each={list.keys()}>
          {(key) => {
            const segment = () => list.get(key)
            return (
              <div
                class="ocv-seg"
                style={{ "flex-grow": grow(segment().value, total()), background: segment().color }}
                onPointerMove={(event) =>
                  props.tip?.show(
                    event,
                    <>
                      <div class="ocv-tip-title">
                        <span class="ocv-swatch" style={{ background: segment().color }} />
                        {segment().label}
                      </div>
                      <div>
                        {format(segment().value)} · {f.share(segment().value, props.max ?? total())}
                      </div>
                      <Show when={segment().detail}>
                        <div class="ocv-muted">{segment().detail}</div>
                      </Show>
                    </>,
                  )
                }
                onPointerLeave={() => props.tip?.hide()}
              />
            )
          }}
        </For>
      </div>
    </div>
  )
}

/** A legend for segments, with values and their share of `total`; `free` adds a row for the room left. */
export function Legend(props: {
  readonly segments: readonly Segment[]
  readonly total?: number
  readonly free?: number
  readonly format?: (v: number) => string
}) {
  const list = keyed(() => props.segments)
  const total = () => props.total ?? props.segments.reduce((sum, s) => sum + s.value, 0)
  const format = (value: number) => (props.format ?? f.tokens)(value)
  return (
    <ul class="ocv-legend">
      <For each={list.keys()}>
        {(key) => {
          const segment = () => list.get(key)
          return (
            <li title={segment().detail}>
              <span class="ocv-swatch" style={{ background: segment().color }} />
              <span class="ocv-legend-label">{segment().label}</span>
              <span class="ocv-num">{format(segment().value)}</span>
              <span class="ocv-num ocv-legend-share">{f.share(segment().value, total())}</span>
            </li>
          )
        }}
      </For>
      <Show when={props.free !== undefined}>
        <li class="ocv-legend-free">
          <span class="ocv-swatch ocv-swatch-free" />
          <span class="ocv-legend-label">Free space</span>
          <span class="ocv-num">{format(props.free!)}</span>
          <span class="ocv-num ocv-legend-share">{f.share(props.free!, total())}</span>
        </li>
      </Show>
    </ul>
  )
}

/** A small legend without values, for a chart whose values live in its tooltips. */
export function Key(props: { readonly items: readonly { label: string; color: string }[] }) {
  return (
    <div class="ocv-key">
      <For each={props.items}>
        {(item) => (
          <span>
            <span class="ocv-swatch" style={{ background: item.color }} />
            {item.label}
          </span>
        )}
      </For>
    </div>
  )
}

const KINDS = ["reasoning", "text", "calls"] as const

/** Below this much context, a request with no cache hit is unremarkable: providers don't cache short prompts. */
const MISS_MIN = 4096

/** A request's cost as stacked parts: by kind when it splits, else one "reported" part. */
const costParts = (cost: Cost | undefined): (readonly [string, number, string])[] => {
  if (!cost || cost.kind === "none") return []
  if (!cost.split) return [["reported", cost.value, COST.output.color]]
  return SPLIT_KEYS.map((key) => [key, cost.split![key], COST[key].color] as const)
}

/** The room between columns, less as they crowd in, so a long session still fits. */
const gapFor = (n: number) => (n <= 16 ? 6 : n <= 40 ? 3 : n <= 90 ? 2 : n <= 200 ? 1 : 0)

/**
 * The session request by request, on one x axis of request number. Above: the context each request sent, stacked by
 * what it held, with compactions as dashed rules and the model's limit as a dashed line when the curve comes near it.
 * Below, on its own scale: what each request produced (thinking, text, tool-call arguments). One column per request,
 * up to 36px wide and left-aligned, so a short session grows to the right and a long one packs them in. Hover reads a
 * request out; click picks it in the turn trace.
 */
export function ContextChart(props: {
  readonly points: readonly ContextPoint[]
  readonly compactions: readonly number[]
  readonly palette: Palette
  readonly limit?: number
  readonly tip: Tip
  /** The step a request ran as, for its tools and cost. */
  readonly step: (id: string) => Step | undefined
  /** The turn a request belongs to, for the turn's cost in the tooltip. */
  readonly turn: (id: string) => Turn | undefined
  readonly selected?: string
  readonly onSelect: (point: ContextPoint) => void
}) {
  const [hover, setHover] = createSignal<number>()
  const n = () => props.points.length
  const peak = () => props.points.reduce((max, p) => Math.max(max, p.total), 0)
  const showLimit = () => !!props.limit && props.limit < peak() * 1.6
  const top = () => Math.max(1, showLimit() ? Math.max(peak(), props.limit!) : peak()) * 1.05
  const peakOut = () => props.points.reduce((max, p) => Math.max(max, p.produced.reasoning + p.produced.text + p.produced.calls), 1)
  const costOfPoint = (point: ContextPoint) => props.step(point.step)?.cost
  const peakCost = () => props.points.reduce((max, p) => Math.max(max, costOfPoint(p)?.value ?? 0), 0)
  const totalCost = () => props.points.reduce((sum, p) => sum + (costOfPoint(p)?.value ?? 0), 0)
  // Whether the provider caches at all: without any hit in the session, a request without one isn't a miss.
  const caches = () => props.points.some((p) => (props.step(p.step)?.usage.cacheRead ?? 0) > 0)
  const selectedIndex = () => (props.selected ? props.points.findIndex((p) => p.step === props.selected) : -1)

  // Where each turn starts, for ticks and labels under the chart.
  const turnStarts = createMemo(() => {
    const starts = new Map<number, number>()
    props.points.forEach((point, i) => {
      if (i === 0 || props.points[i - 1]!.turn !== point.turn) starts.set(i, point.turn)
    })
    return starts
  })

  const indexAt = (event: MouseEvent): number | undefined => {
    const hit = (event.target as Element | null)?.closest?.("[data-index]")
    return hit ? Number(hit.getAttribute("data-index")) : undefined
  }

  const leave = () => {
    setHover(undefined)
    props.tip.hide()
  }

  const move = (event: PointerEvent) => {
    const index = indexAt(event)
    const point = index === undefined ? undefined : props.points[index]
    if (index === undefined || !point) return leave()
    setHover(index)
    // The system share first, as the baseline every request carries, then the largest of the rest.
    const parts = [...grouped(point.parts, props.palette)]
      .sort((a, b) => Number(b[0] === "system") - Number(a[0] === "system") || b[1] - a[1])
      .slice(0, 5)
    const step = props.step(point.step)
    const names = step ? [...new Set(step.tools.map((t) => t.name))] : []
    const out = point.produced
    const cost = step?.cost
    const turn = props.turn(point.step)
    const segmentStart = index === 0 || props.compactions.includes(index)
    const missed = !!step && caches() && !segmentStart && step.usage.cacheRead === 0 && point.total >= MISS_MIN
    props.tip.show(
      event,
      <>
        <div class="ocv-tip-title">
          Request {index + 1} · turn #{point.turn + 1}
        </div>
        <div>
          {f.tokens(point.total)} context{props.limit ? ` · ${f.percent(point.total, props.limit)} of limit` : ""}
        </div>
        <For each={parts}>
          {([key, value]) => (
            <div class="ocv-tip-row">
              <span class="ocv-swatch" style={{ background: props.palette.meta(key).color }} />
              <span>{props.palette.meta(key).label}</span>
              <span class="ocv-num">{f.tokens(value)}</span>
            </div>
          )}
        </For>
        <div class="ocv-tip-sep">Produced</div>
        <For each={KINDS.filter((k) => out[k] >= 1)}>
          {(kind) => (
            <div class="ocv-tip-row">
              <span class="ocv-swatch" style={{ background: PRODUCED[kind].color }} />
              <span>{PRODUCED[kind].label}</span>
              <span class="ocv-num">{f.tokens(out[kind])}</span>
            </div>
          )}
        </For>
        <Show when={cost && cost.kind !== "none"}>
          <div class="ocv-tip-sep">Cost · {f.cost(cost!)}</div>
          <For each={cost!.split ? SPLIT_KEYS.filter((k) => cost!.split![k] > 0) : []}>
            {(key) => (
              <div class="ocv-tip-row">
                <span class="ocv-swatch" style={{ background: COST[key].color }} />
                <span>{COST[key].label}</span>
                <span class="ocv-num">{f.usd(cost!.split![key])}</span>
              </div>
            )}
          </For>
          <Show when={turn}>
            <div class="ocv-muted">
              turn #{turn!.index + 1}: {f.cost(turn!.cost)} over {turn!.steps.length} req
            </div>
          </Show>
          <Show when={missed}>
            <div class="ocv-warn-text">No cache hit: the whole context was billed at full price</div>
          </Show>
        </Show>
        <Show when={names.length}>
          <div class="ocv-muted">called {names.join(", ")}</div>
        </Show>
        <Show when={step}>
          <div class="ocv-muted">
            {point.model.id} · took {f.duration(step!.ms)} · click to open
          </div>
        </Show>
      </>,
    )
  }

  const shared: ViewProps = {
    get points() {
      return props.points
    },
    get compactions() {
      return props.compactions
    },
    get palette() {
      return props.palette
    },
    get limit() {
      return showLimit() ? props.limit : undefined
    },
    top,
    peakOut,
    peakCost,
    totalCost,
    cost: costOfPoint,
    turnStarts,
    hover,
    selected: selectedIndex,
  }

  return (
    <Show when={n() > 0}>
      <div
        class="ocv-chart"
        onPointerMove={move}
        onPointerLeave={leave}
        onClick={(event) => {
          const index = indexAt(event)
          const point = index === undefined ? undefined : props.points[index]
          if (point) props.onSelect(point)
        }}
        role="img"
        aria-label={`Context per request, peaking at ${f.tokens(peak())} tokens`}
      >
        <ColumnView {...shared} />
      </div>
    </Show>
  )
}

interface ViewProps {
  readonly points: readonly ContextPoint[]
  readonly compactions: readonly number[]
  readonly palette: Palette
  /** The limit, when it is worth drawing. */
  readonly limit?: number
  readonly top: () => number
  readonly peakOut: () => number
  readonly peakCost: () => number
  readonly totalCost: () => number
  readonly cost: (point: ContextPoint) => Cost | undefined
  readonly turnStarts: () => ReadonlyMap<number, number>
  readonly hover: () => number | undefined
  readonly selected: () => number
}

function ProducedLabel() {
  return (
    <div class="ocv-chart-label ocv-key">
      <span class="ocv-chart-label-title">What each request produced</span>
      <For each={KINDS}>
        {(kind) => (
          <span>
            <span class="ocv-swatch" style={{ background: PRODUCED[kind].color }} />
            {PRODUCED[kind].label}
          </span>
        )}
      </For>
    </div>
  )
}

const isEstimate = (cost: Cost | undefined) => cost?.kind === "estimated" || cost?.kind === "fallback"

function CostLabel(props: { readonly total: number; readonly estimated: boolean }) {
  return (
    <div class="ocv-chart-label ocv-key">
      <span class="ocv-chart-label-title">
        What each request cost · {props.estimated ? "≈" : ""}
        {f.usd(props.total)}
      </span>
      <For each={SPLIT_KEYS}>
        {(key) => (
          <span>
            <span class="ocv-swatch" style={{ background: COST[key].color }} />
            {COST[key].label}
          </span>
        )}
      </For>
    </div>
  )
}

/** One column per request, keyed by its step so a new one grows in and the rest ease to the new scale. */
function ColumnView(props: ViewProps) {
  const byStep = createMemo(() => new Map(props.points.map((point, i) => [point.step, { point, i }])))
  const steps = () => props.points.map((p) => p.step)
  const at = (step: string) => byStep().get(step)
  const compacted = createMemo(() => new Set(props.compactions))
  const n = () => props.points.length
  const rowStyle = () => ({ gap: `${gapFor(n())}px` })
  // Label every turn when there's room, else every k-th.
  const every = () => Math.max(1, Math.ceil(props.turnStarts().size / 10))
  const turnOrder = createMemo(() => new Map([...props.turnStarts().keys()].map((index, k) => [index, k])))

  const Column = (p: { readonly step: string; readonly children: (point: () => ContextPoint) => JSX.Element; readonly class: string }) => {
    const hit = () => at(p.step)
    return (
      <Show when={hit()}>
        {(h) => (
          <div
            class={`ocv-col ${p.class}`}
            classList={{
              "ocv-col-hover": props.hover() === h().i,
              "ocv-col-selected": props.selected() === h().i,
              "ocv-col-compacted": compacted().has(h().i),
            }}
            data-index={h().i}
          >
            {p.children(() => h().point)}
          </div>
        )}
      </Show>
    )
  }

  const Stack = (p: { readonly height: number; readonly segments: readonly (readonly [string, number, string])[] }) => {
    const list = keyed(() => p.segments.filter(([, v]) => v > 0).map(([key, value, color]) => ({ key, value, color, label: key })))
    const total = () => p.segments.reduce((sum, [, v]) => sum + Math.max(0, v), 0)
    return (
      <div class="ocv-col-stack" style={{ height: `${Math.min(100, p.height)}%` }}>
        <For each={list.keys()}>
          {(key) => <div class="ocv-col-seg" style={{ "flex-grow": grow(list.get(key).value, total()), background: list.get(key).color }} />}
        </For>
      </div>
    )
  }

  const contextParts = (point: ContextPoint) => {
    const parts = grouped(point.parts, props.palette)
    return props.palette.order.map((key) => [key, parts.get(key) ?? 0, props.palette.meta(key).color] as const)
  }
  const producedParts = (point: ContextPoint) => KINDS.map((kind) => [kind, point.produced[kind], PRODUCED[kind].color] as const)
  const outTotal = (point: ContextPoint) => point.produced.reasoning + point.produced.text + point.produced.calls

  return (
    <div classList={{ "ocv-cols-dense": n() > 60 }}>
      <div class="ocv-cols ocv-cols-context" style={rowStyle()}>
        <Show when={props.limit}>
          <div class="ocv-col-limit" style={{ bottom: `${(props.limit! / props.top()) * 100}%` }} />
        </Show>
        <For each={steps()}>
          {(step) => (
            <Column step={step} class="ocv-col-context">
              {(point) => <Stack height={(point().total / props.top()) * 100} segments={contextParts(point())} />}
            </Column>
          )}
        </For>
      </div>
      <ProducedLabel />
      <div class="ocv-cols ocv-cols-produced" style={rowStyle()}>
        <For each={steps()}>
          {(step) => (
            <Column step={step} class="ocv-col-produced">
              {(point) => <Stack height={(outTotal(point()) / props.peakOut()) * 100} segments={producedParts(point())} />}
            </Column>
          )}
        </For>
      </div>
      <Show when={props.peakCost() > 0}>
        <CostLabel total={props.totalCost()} estimated={props.points.some((p) => isEstimate(props.cost(p)))} />
        <div class="ocv-cols ocv-cols-cost" style={rowStyle()}>
          <For each={steps()}>
            {(step) => (
              <Column step={step} class="ocv-col-cost">
                {(point) => {
                  const cost = () => props.cost(point())
                  return <Stack height={((cost()?.value ?? 0) / props.peakCost()) * 100} segments={costParts(cost())} />
                }}
              </Column>
            )}
          </For>
        </div>
      </Show>
      <div class="ocv-cols ocv-cols-axis" style={rowStyle()}>
        <For each={steps()}>
          {(step) => {
            const index = () => at(step)?.i ?? -1
            const turn = () => props.turnStarts().get(index())
            const labelled = () => (turnOrder().get(index()) ?? 1) % every() === 0
            return (
              <div class="ocv-col ocv-col-tick" classList={{ "ocv-col-turn": turn() !== undefined }}>
                <Show when={turn() !== undefined && labelled()}>#{turn()! + 1}</Show>
              </div>
            )
          }}
        </For>
      </div>
    </div>
  )
}
