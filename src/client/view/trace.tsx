import { createMemo, For, Match, Show, Switch, type JSX } from "solid-js"
import * as f from "../../format"
import { contextOf, type ContextPoint, type Marker, type Step, type ToolCall, type Turn } from "../../model"
import type { Dashboard } from "../store"
import { grouped, PRODUCED, TIME, type Palette } from "./buckets"
import { Code, languageOf } from "./code"
import { inputFields, shellTokens } from "./input"
import { Legend, StackBar, type Segment } from "./charts"
import type { Tip } from "./tip"

// A turn as a waterfall, after wigglystuff's TraceView: one row per span, in time order (each request, then the tool
// calls it made), with a bar on the turn's timeline and its duration. Flat: most requests make one tool call or none, so
// nesting calls under their request mostly adds rows to read past.
// The turn itself is the timeline, so it gets no row of its own. Click a row for its details.

type State = "running" | "ok" | "error"

interface Bar {
  readonly start: number
  readonly end: number
  readonly color: string
  readonly label: string
}

interface Row {
  readonly id: string
  readonly kind: "request" | "tool" | "marker"
  readonly label: string
  readonly detail: string
  readonly start: number
  readonly end: number
  readonly state: State
  readonly bars: readonly Bar[]
  readonly step?: Step
  readonly tool?: ToolCall
  readonly marker?: Marker
}

const stepEnd = (step: Step, now: number) => step.completed ?? (step.running ? now : step.created + step.ms)

/** When a request's model time ends: its tools follow, on rows of their own. */
const modelEndOf = (step: Step, now: number) => (step.pending ? stepEnd(step, now) : step.created + step.modelMs)

/** A request's bar: thinking where its reasoning ran, generating for the rest of the model's time. */
const requestBars = (step: Step, now: number): Bar[] => {
  const modelEnd = modelEndOf(step, now)
  const bars: Bar[] = [
    { start: step.created, end: modelEnd, color: TIME.model.color, label: step.pending ? "Waiting on the model" : TIME.model.label },
  ]
  for (const [start, stop] of step.thinking)
    bars.push({ start: Math.max(step.created, start), end: Math.min(modelEnd, stop), color: TIME.thinking.color, label: TIME.thinking.label })
  return bars
}

const stateOf = (running: boolean, error: boolean): State => (running ? "running" : error ? "error" : "ok")

/** The rows of a turn: its requests and markers in time order, each request followed by its tool calls. */
const rowsOf = (turn: Turn, now: number): Row[] => {
  const groups: Row[][] = turn.steps.map((step) => [
    {
      id: step.id,
      kind: "request",
      label: step.model.id.split("/").pop() || step.model.id,
      detail: step.pending ? "waiting for the reply…" : `${f.tokens(step.context)} ctx · ${f.tokens(step.usage.output + step.usage.reasoning)} out`,
      start: step.created,
      end: modelEndOf(step, now),
      // Its own part is the model's; once the reply is in, its tools' rows say what's still running.
      state: stateOf(step.running && !!step.pending, !!step.error),
      bars: requestBars(step, now),
      step,
    },
    ...step.tools.map((tool): Row => {
      const start = tool.ran ?? tool.created
      const end = tool.completed ?? (tool.status === "running" && step.running ? now : start + tool.ms)
      return {
        id: tool.id,
        kind: "tool",
        label: tool.name,
        detail: tool.summary,
        start,
        end,
        state: stateOf(tool.status === "running" && step.running, tool.status === "error"),
        bars: [{ start, end, color: TIME.tools.color, label: TIME.tools.label }],
        tool,
      }
    }),
  ])
  for (const marker of turn.markers)
    groups.push([{ id: marker.id, kind: "marker", label: marker.label, detail: "", start: marker.time, end: marker.time, state: "ok", bars: [], marker }])
  return groups.sort((a, b) => a[0]!.start - b[0]!.start).flat()
}

/** Round tick steps for a span of `ms`, about four of them. */
const ticks = (ms: number): number[] => {
  const steps = [100, 250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000]
  const step = steps.find((s) => ms / s <= 5) ?? Math.ceil(ms / 4 / 3_600_000) * 3_600_000
  const out: number[] = []
  for (let t = 0; t <= ms; t += step) out.push(t)
  return out
}

export function TurnTrace(props: {
  readonly turn: Turn
  readonly dashboard: Dashboard
  readonly palette: Palette
  readonly now: number
  readonly tip: Tip
  readonly selected?: string
  readonly onSelect: (id: string | undefined) => void
}) {
  const rows = createMemo(() => rowsOf(props.turn, props.now))
  const t0 = () => props.turn.start
  const span = () => Math.max(1, props.turn.end - props.turn.start)
  const left = (time: number) => `${Math.max(0, Math.min(100, ((time - t0()) / span()) * 100))}%`
  const width = (start: number, end: number) => `${Math.max(0, ((Math.min(end, props.turn.end) - Math.max(start, t0())) / span()) * 100)}%`
  const selectedRow = () => rows().find((r) => r.id === props.selected)

  return (
    <div class="ocv-trace">
      <div class="ocv-trace-row ocv-trace-head">
        <div>Request</div>
        <div class="ocv-trace-axis">
          <For each={ticks(span()).filter((tick) => tick / span() < 0.78)}>
            {(tick) => <span style={{ left: `${(tick / span()) * 100}%` }}>{tick === 0 ? "0" : f.duration(tick)}</span>}
          </For>
        </div>
        <div class="ocv-num">Took</div>
      </div>
      <div class="ocv-trace-body">
        <For each={rows()}>
          {(row) => (
            <div
              class={`ocv-trace-row ocv-trace-${row.kind} ocv-state-${row.state}`}
              classList={{ "ocv-trace-selected": row.id === props.selected }}
              onClick={() => props.onSelect(row.id === props.selected ? undefined : row.id)}
            >
              <div class="ocv-trace-name">
                <span class={`ocv-pip ocv-pip-${row.state}`} />
                <span class="ocv-trace-label" title={row.label}>
                  {row.label}
                </span>
                <span class="ocv-trace-detail" title={row.detail}>
                  {row.detail}
                </span>
              </div>
              <div class="ocv-trace-lane">
                <For each={ticks(span())}>{(tick) => <span class="ocv-grid" style={{ left: `${(tick / span()) * 100}%` }} />}</For>
                <Show
                  when={row.kind !== "marker"}
                  fallback={<span class="ocv-instant" style={{ left: left(row.start) }} title={row.label} />}
                >
                  <For each={row.bars}>
                    {(bar) => (
                      <span
                        class="ocv-trace-bar"
                        style={{ left: left(bar.start), width: width(bar.start, bar.end), background: bar.color }}
                        onPointerMove={(event) =>
                          props.tip.show(
                            event,
                            <>
                              <div class="ocv-tip-title">
                                <span class="ocv-swatch" style={{ background: bar.color }} />
                                {bar.label}
                              </div>
                              <div>
                                {f.duration(bar.end - bar.start)} · from +{f.duration(bar.start - t0())}
                              </div>
                            </>,
                          )
                        }
                        onPointerLeave={() => props.tip.hide()}
                      />
                    )}
                  </For>
                </Show>
              </div>
              <div class="ocv-num ocv-trace-took">
                {row.kind === "marker" ? "" : row.state === "running" ? <span class="ocv-live">{f.duration(row.end - row.start)}</span> : f.duration(row.end - row.start)}
              </div>
            </div>
          )}
        </For>
      </div>
      <Show when={selectedRow()} fallback={<TurnFooter turn={props.turn} />}>
        {(row) => <Details row={row()} dashboard={props.dashboard} palette={props.palette} t0={t0()} tip={props.tip} />}
      </Show>
    </div>
  )
}

function KV(props: { readonly k: string; readonly children: JSX.Element }) {
  return (
    <>
      <dt>{props.k}</dt>
      <dd>{props.children}</dd>
    </>
  )
}

function Pill(props: { readonly state: State }) {
  return <span class={`ocv-pill ocv-pill-${props.state}`}>{{ running: "Running", ok: "Ok", error: "Error" }[props.state]}</span>
}

function Details(props: { readonly row: Row; readonly dashboard: Dashboard; readonly palette: Palette; readonly t0: number; readonly tip: Tip }) {
  const header = () => (
    <div class="ocv-details-head">
      <span class="ocv-details-title">{props.row.label}</span>
      <Pill state={props.row.state} />
      <span class="ocv-muted">
        starts +{f.duration(props.row.start - props.t0)} · took {f.duration(props.row.end - props.row.start)}
      </span>
    </div>
  )
  return (
    <div class="ocv-details">
      {header()}
      <Switch>
        <Match when={props.row.step}>{(step) => <StepDetails step={step()} dashboard={props.dashboard} palette={props.palette} tip={props.tip} />}</Match>
        <Match when={props.row.tool}>{(tool) => <ToolDetails tool={tool()} />}</Match>
        <Match when={props.row.marker}>{(marker) => <div class="ocv-muted">{marker().label}</div>}</Match>
      </Switch>
    </div>
  )
}

function StepDetails(props: { readonly step: Step; readonly dashboard: Dashboard; readonly palette: Palette; readonly tip: Tip }) {
  const point = (): ContextPoint | undefined => props.dashboard.timeline.points.find((p) => p.step === props.step.id)
  const segments = (): Segment[] => {
    const p = point()
    if (!p) return []
    return [...grouped(p.parts, props.palette)]
      .filter(([, v]) => v >= 1)
      .sort((a, b) => b[1] - a[1])
      .map(([key, value]) => ({ key, value, ...props.palette.meta(key) }))
  }
  const produced = (): Segment[] => {
    const p = point()
    if (!p) return []
    return (["reasoning", "text", "calls"] as const).map((kind) => ({ key: kind, value: p.produced[kind], ...PRODUCED[kind] }))
  }
  const s = () => props.step
  return (
    <>
      <Show when={s().error}>
        <div class="ocv-error-text">{s().error}</div>
      </Show>
      <dl class="ocv-kv">
        <KV k="model">
          {s().model.providerID}/{s().model.id}
          {s().model.variant && s().model.variant !== "default" ? ` · thinking ${s().model.variant}` : ""}
          {s().agent ? ` · ${s().agent}` : ""}
        </KV>
        <KV k="finish">{s().pending ? "waiting for the reply" : s().finish ?? (s().running ? "running" : "—")}</KV>
        <KV k="time">
          <Show when={s().thinkingMs > 0}>
            <span title="pi doesn't time thinking: this is its share of the output, of the model's time">
              thinking ≈{f.duration(s().thinkingMs)} ·{" "}
            </span>
          </Show>
          generating {f.duration(s().modelMs - s().thinkingMs)} · tools {f.duration(s().toolMs)}
        </KV>
        <KV k="tokens">
          {f.tokens(contextOf(s().usage))} context ({f.tokens(s().usage.input)} new · {f.tokens(s().usage.cacheRead)} cached
          {s().usage.cacheWrite ? ` · ${f.tokens(s().usage.cacheWrite)} cache write` : ""}) · {f.tokens(s().usage.output)} out
          {s().usage.reasoning ? ` · ${f.tokens(s().usage.reasoning)} reasoning` : ""}
        </KV>
        <KV k="cost">
          <span title={f.costNote(s().cost)}>{f.cost(s().cost)}</span>
        </KV>
      </dl>
      <Show when={segments().length}>
        <h4>What its context held</h4>
        <StackBar segments={segments()} tip={props.tip} height={10} />
        <Legend segments={segments().slice(0, 6)} total={point()!.total} />
        <h4>What it produced</h4>
        <Legend segments={produced().filter((p) => p.value >= 1)} />
      </Show>
      <Show when={s().reasoning.trim()}>
        <details class="ocv-preview">
          <summary>Thinking · {f.tokens(s().reasoningChars / 4)} tokens est.</summary>
          <pre>{s().reasoning}</pre>
        </details>
      </Show>
      <Show when={s().text.trim()}>
        <details class="ocv-preview" open>
          <summary>Text</summary>
          <pre>{s().text}</pre>
        </details>
      </Show>
    </>
  )
}

/** How much of a long input to show; the result is already cut short by the server. */
const MAX_INPUT = 4000

/** A bash call's command, if this is one. */
const commandOf = (tool: ToolCall) => {
  const input = tool.input as { command?: unknown } | undefined
  return tool.name === "bash" && typeof input?.command === "string" ? input.command : undefined
}

/** The file a call reads or writes, whose extension says what language its text is. */
const pathOf = (tool: ToolCall) => {
  const input = tool.input as { path?: unknown; file_path?: unknown } | undefined
  const path = input?.path ?? input?.file_path
  return typeof path === "string" ? path : undefined
}

/** Arguments that hold code: highlighted as the file's language, or as what they look like. */
const CODE = new Set(["content", "oldText", "newText", "code"])

/** An edit's replacements: what went, then what came, each as the file's language. */
function Edits(props: { readonly edits: readonly unknown[]; readonly language?: string }) {
  const pairs = () =>
    props.edits.flatMap((e) => {
      const edit = e as { oldText?: unknown; newText?: unknown }
      return typeof edit?.oldText === "string" && typeof edit.newText === "string" ? [{ old: edit.oldText, new: edit.newText }] : []
    })
  return (
    <For each={pairs()}>
      {(pair, i) => (
        <>
          <h4>
            edit {i() + 1}
            {pairs().length > 1 ? ` of ${pairs().length}` : ""}
          </h4>
          <Code class="ocv-del" text={pair.old.slice(0, MAX_INPUT)} language={props.language} />
          <Code class="ocv-add" text={pair.new.slice(0, MAX_INPUT)} language={props.language} />
        </>
      )}
    </For>
  )
}

/** A call's input: its arguments by name, text as written rather than JSON-escaped, a bash command a step a line. */
function InputFields(props: { readonly tool: ToolCall; readonly language?: string }) {
  const fields = createMemo(() => inputFields(props.tool.name, props.tool.input))
  return (
    <For each={fields()}>
      {(field) => (
        <Switch
          fallback={
            <>
              <Show when={field.key}>
                <h4>{field.key}</h4>
              </Show>
              <pre>{field.text.slice(0, MAX_INPUT)}</pre>
            </>
          }
        >
          <Match when={field.key === "command" && props.tool.name === "bash"}>
            <pre class="ocv-term">
              <For each={shellTokens(field.text.slice(0, MAX_INPUT))}>{(token) => <span class={`ocv-sh-${token.kind}`}>{token.text}</span>}</For>
            </pre>
          </Match>
          <Match when={field.key === "edits" && Array.isArray(field.value) && (field.value as unknown[])}>
            {(edits) => <Edits edits={edits()} language={props.language} />}
          </Match>
          <Match when={!field.block}>
            <div class="ocv-input-inline">
              <span class="ocv-input-key">{field.key}</span> {field.text}
            </div>
          </Match>
          <Match when={CODE.has(field.key)}>
            <h4>{field.key}</h4>
            <Code text={field.text.slice(0, MAX_INPUT)} language={props.language} guess={field.key === "code" && !props.language} />
          </Match>
        </Switch>
      )}
    </For>
  )
}

/** What went in and what came out. */
function ToolIO(props: { readonly tool: ToolCall }) {
  const t = () => props.tool
  const bash = () => commandOf(t()) !== undefined
  const language = () => languageOf(pathOf(t()))
  const done = () => t().status === "completed" || t().status === "error"
  return (
    <>
      <details class="ocv-preview" open>
        <summary>Input</summary>
        <InputFields tool={t()} language={language()} />
      </details>
      <details class="ocv-preview" open>
        <summary>Output{t().outputChars > t().output.length ? ` (first ${t().output.length.toLocaleString()} of ${t().outputChars.toLocaleString()} chars)` : ""}</summary>
        <Show when={t().output} fallback={<div class="ocv-muted ocv-small">{done() ? "No output." : "Running…"}</div>}>
          <Show
            when={!bash()}
            fallback={
              <pre class="ocv-term" classList={{ "ocv-term-error": t().status === "error" }}>
                {t().output}
              </pre>
            }
          >
            <Code text={t().output} language={t().name === "read" ? language() : undefined} />
          </Show>
        </Show>
      </details>
    </>
  )
}

function ToolDetails(props: { readonly tool: ToolCall }) {
  const t = () => props.tool
  return (
    <>
      <Show when={t().error}>
        <div class="ocv-error-text">{t().error}</div>
      </Show>
      <dl class="ocv-kv">
        <KV k="status">{t().status}</KV>
        <KV k="time">
          {t().ran !== undefined ? `waited ${f.duration(t().ran! - t().created)} to start · ` : ""}ran {f.duration(t().ms)}
        </KV>
        <KV k="result">
          {f.tokens(t().outputChars / 4)} tokens est. into the context ({t().outputChars.toLocaleString()} chars)
        </KV>
        <Show when={t().usage}>
          {(usage) => (
            <KV k="own model use">
              {f.tokens(contextOf(usage()))} in · {f.tokens(usage().output + usage().reasoning)} out
              <Show when={t().cost}> · {f.cost(t().cost!)}</Show>
            </KV>
          )}
        </Show>
      </dl>
      <ToolIO tool={t()} />
    </>
  )
}

/** With no row picked: the turn's full prompt (the list above only shows its first line), folded. */
function TurnFooter(props: { readonly turn: Turn }) {
  const prompt = () => f.stripBlocks(props.turn.prompt).trim() || props.turn.prompt
  return (
    <div class="ocv-trace-hint">
      <Show when={prompt()} fallback={<span class="ocv-muted ocv-small">Click a row for its details.</span>}>
        <details class="ocv-preview ocv-trace-prompt">
          <summary>
            Prompt <span class="ocv-small">· click a row for its details</span>
          </summary>
          <pre>{prompt()}</pre>
        </details>
      </Show>
    </div>
  )
}
