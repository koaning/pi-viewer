import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import type { SessionSummary } from "../api"
import * as f from "../format"
import { modelInfo } from "./catalog"
import { helpOpen, MOD, plain, typing } from "./keys"
import { ago, BUCKETS, bucketOf, isOneShot, projectOf, shortModel, tilde, titleOf } from "./list"

// Every session pi has on disk. The ones running now as cards on top; under them the rest, by day or by project.
// Sessions of one prompt and one reply (title generators, pings) stay out of the way until asked for.

const [sessions, setSessions] = createSignal<readonly SessionSummary[]>([])
const [loaded, setLoaded] = createSignal(false)
let source: EventSource | undefined
const follow = () => {
  if (source) return
  source = new EventSource("/api/sessions/stream")
  source.onmessage = (message) => {
    const event = JSON.parse(message.data) as { type: "sessions"; sessions: SessionSummary[] }
    if (event.type === "sessions") {
      setSessions(event.sessions)
      setLoaded(true)
    }
  }
}

/** A choice remembered in this browser. */
const remembered = <T extends string>(key: string, values: readonly T[], fallback: T) => {
  const read = (): T => {
    try {
      const value = localStorage.getItem(key) as T | null
      return value && values.includes(value) ? value : fallback
    } catch {
      return fallback
    }
  }
  const [value, setValue] = createSignal<T>(read())
  const set = (next: T) => {
    setValue(() => next)
    try {
      localStorage.setItem(key, next)
    } catch {
      // Private mode: it lasts for this page.
    }
  }
  return [value, set] as const
}

const VIEWS = ["recent", "projects"] as const
type View = (typeof VIEWS)[number]
const [view, setView] = remembered<View>("pi-viewer:home-view", VIEWS, "recent")
const [oneShots, setOneShots] = remembered("pi-viewer:one-shots", ["hide", "show"] as const, "hide")

/** Sessions of the "Earlier" group shown before "show older". */
const EARLIER = 8

let searchBox: HTMLInputElement | undefined
let focusOnMount = false

/** Puts the cursor in the search, now or when the list is next shown. */
export const focusSearch = () => {
  if (searchBox?.isConnected) {
    searchBox.focus()
    searchBox.select()
  } else focusOnMount = true
}

/** What ↑ and ↓ move through, in the order they're shown: cards, then sessions and projects. */
const items = () => [...document.querySelectorAll<HTMLElement>(".pv-home .pv-card, .pv-home .pv-row")]
const moveTo = (el: HTMLElement | undefined) => {
  if (!el) return
  el.focus()
  el.scrollIntoView({ block: "nearest" })
}
/** One step down (+1) or up (-1) the list. Up from the top goes back to the search. */
const step = (by: 1 | -1) => {
  const list = items()
  const at = list.indexOf(document.activeElement as HTMLElement)
  if (at < 0) return moveTo(by > 0 ? list[0] : list.at(-1))
  if (at === 0 && by < 0) return focusSearch()
  moveTo(list[Math.min(list.length - 1, at + by)])
}

const contextShare = (s: SessionSummary) => {
  const window = modelInfo(s.model && { providerID: s.model.provider, id: s.model.id }, true)?.contextWindow
  return window && s.context ? s.context / window : undefined
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

export function Home() {
  follow()
  const [query, setQuery] = createSignal("")
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 30_000)
  onCleanup(() => clearInterval(timer))
  onMount(() => {
    if (focusOnMount) focusSearch()
    focusOnMount = false
  })

  const onKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || helpOpen() || typing(event.target) || !plain(event)) return
    const key = event.key
    if (key === "ArrowDown" || key === "j") step(1)
    else if (key === "ArrowUp" || key === "k") step(-1)
    else if (key === "r") setView("recent")
    else if (key === "p") setView("projects")
    else if (key === "h") setOneShots(oneShots() === "hide" ? "show" : "hide")
    else if (key === "Escape" && items().includes(document.activeElement as HTMLElement)) focusSearch()
    else return
    event.preventDefault()
  }
  window.addEventListener("keydown", onKey)
  onCleanup(() => window.removeEventListener("keydown", onKey))

  const onSearchKey = (event: KeyboardEvent & { currentTarget: HTMLInputElement }) => {
    if (event.key === "ArrowDown") {
      event.preventDefault()
      moveTo(items()[0])
    } else if (event.key === "Enter") {
      // The first session that matches, not a project row.
      const first = items().find((el) => el instanceof HTMLAnchorElement)
      if (first) {
        event.preventDefault()
        first.click()
      }
    } else if (event.key === "Escape") {
      event.preventDefault()
      if (event.currentTarget.value) setQuery("")
      else event.currentTarget.blur()
    }
  }

  const searching = () => query().trim().length > 0
  const matches = (s: SessionSummary) => {
    const q = query().trim().toLowerCase()
    if (!q) return true
    return [s.name, s.firstPrompt, s.cwd, s.model?.id, s.id].some((v) => v?.toLowerCase().includes(q))
  }
  const all = createMemo(() => sessions().filter((s) => s.requests > 0 || s.prompts > 0))
  const hidden = createMemo(() => (oneShots() === "hide" ? all().filter((s) => isOneShot(s) && !s.running).length : 0))
  // Searching looks through everything, one-shots too.
  const visible = createMemo(() =>
    all().filter((s) => (searching() ? matches(s) : oneShots() === "show" || s.running || !isOneShot(s))),
  )
  const running = createMemo(() => visible().filter((s) => s.running))
  const rest = createMemo(() => visible().filter((s) => !s.running))
  const totals = createMemo(() => ({
    sessions: visible().length,
    projects: new Set(visible().map((s) => projectOf(s.cwd).key)).size,
    cost: visible().reduce((sum, s) => sum + s.cost, 0),
  }))

  return (
    <div class="pv-home">
      <div class="pv-home-head">
        <div class="pv-home-title">
          <h1>Sessions</h1>
          <Show when={loaded() && totals().sessions}>
            <span class="pv-muted">
              {plural(totals().sessions, "session")} · {plural(totals().projects, "project")}
              {totals().cost > 0 ? ` · ${f.usd(totals().cost)}` : ""}
            </span>
          </Show>
        </div>
        <div class="pv-segmented" role="tablist" aria-label="Group sessions">
          <For each={VIEWS}>
            {(v) => (
              <button role="tab" aria-selected={view() === v} classList={{ "pv-on": view() === v }} onClick={() => setView(v)}>
                {v === "recent" ? "Recent" : "Projects"}
              </button>
            )}
          </For>
        </div>
      </div>
      <div class="pv-search-wrap">
        <input
          ref={searchBox}
          class="pv-search"
          type="search"
          placeholder="Filter by prompt, project or model"
          aria-keyshortcuts={MOD === "⌘" ? "Meta+K" : "Control+K"}
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={onSearchKey}
        />
        <kbd class="pv-kbd pv-search-hint">{MOD} K</kbd>
      </div>
      <Show when={loaded()} fallback={<div class="pv-muted pv-pad">Reading sessions…</div>}>
        <Show when={all().length} fallback={<div class="pv-muted pv-pad">No pi sessions yet. Start <code>pi</code> somewhere and this fills in.</div>}>
          <Show when={running().length}>
            <section class="pv-group">
              <h2 class="pv-label">
                Running <span>{running().length}</span>
              </h2>
              <div class="pv-cards">
                <For each={running()}>{(s) => <Card session={s} />}</For>
              </div>
            </section>
          </Show>
          <Show when={view() === "recent"} fallback={<ProjectsView sessions={rest()} now={now()} open={searching()} />}>
            <RecentView sessions={rest()} now={now()} open={searching()} />
          </Show>
          <Show when={searching() && !visible().length}>
            <div class="pv-muted pv-pad">Nothing matches “{query()}”.</div>
          </Show>
          <Show when={!searching() && (hidden() || oneShots() === "show")}>
            <div class="pv-foot">
              <Show
                when={oneShots() === "hide"}
                fallback={
                  <button class="pv-more" onClick={() => setOneShots("hide")}>
                    Hide one-shot sessions
                  </button>
                }
              >
                <span class="pv-muted">{plural(hidden(), "one-shot session")} hidden</span>
                <button class="pv-more" onClick={() => setOneShots("show")}>
                  Show
                </button>
              </Show>
            </div>
          </Show>
        </Show>
      </Show>
    </div>
  )
}

function RecentView(props: { readonly sessions: readonly SessionSummary[]; readonly now: number; readonly open: boolean }) {
  const [older, setOlder] = createSignal(false)
  const groups = createMemo(() => {
    const byBucket = new Map(BUCKETS.map((b) => [b, [] as SessionSummary[]]))
    for (const s of props.sessions) byBucket.get(bucketOf(s.modified, props.now))!.push(s)
    return [...byBucket].filter(([, list]) => list.length)
  })
  return (
    <For each={groups()}>
      {([bucket, list]) => {
        const capped = () => bucket === "Earlier" && !older() && !props.open
        const shown = () => (capped() ? list.slice(0, EARLIER) : list)
        return (
          <section class="pv-group">
            <h2 class="pv-label">
              {bucket} <span>{list.length}</span>
            </h2>
            <ul class="pv-rows">
              <For each={shown()}>{(s) => <Row session={s} now={props.now} project />}</For>
            </ul>
            <Show when={shown().length < list.length}>
              <button class="pv-more" onClick={() => setOlder(true)}>
                Show {list.length - shown().length} older
              </button>
            </Show>
          </section>
        )
      }}
    </For>
  )
}

function ProjectsView(props: { readonly sessions: readonly SessionSummary[]; readonly now: number; readonly open: boolean }) {
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set())
  const toggle = (key: string) =>
    setExpanded((set) => {
      const next = new Set(set)
      if (!next.delete(key)) next.add(key)
      return next
    })
  const projects = createMemo(() => {
    const groups = new Map<string, { name: string; key: string; sessions: SessionSummary[]; workspaces: Set<string> }>()
    for (const s of props.sessions) {
      const p = projectOf(s.cwd)
      const group = groups.get(p.key) ?? { name: p.name, key: p.key, sessions: [], workspaces: new Set() }
      group.sessions.push(s)
      if (p.workspace) group.workspaces.add(p.workspace)
      groups.set(p.key, group)
    }
    // Two projects of one name (~/notebooks, and a worktree repo called notebooks) go by their paths instead.
    const names = new Map<string, number>()
    for (const g of groups.values()) names.set(g.name, (names.get(g.name) ?? 0) + 1)
    for (const g of groups.values()) if (names.get(g.name)! > 1) g.name = tilde(g.key)
    // Sessions come newest first, so a project's first one is its latest.
    return [...groups.values()]
  })
  return (
    <section class="pv-group">
      <h2 class="pv-label">
        Projects <span>{projects().length}</span>
      </h2>
      <ul class="pv-rows">
        <For each={projects()}>
          {(p) => {
            const open = () => props.open || expanded().has(p.key)
            const cost = () => p.sessions.reduce((sum, s) => sum + s.cost, 0)
            return (
              <li class="pv-project" classList={{ "pv-open": open() }}>
                <button class="pv-row pv-project-row" aria-expanded={open()} onClick={() => toggle(p.key)} title={tilde(p.key)}>
                  <span class="pv-row-title">
                    <span class="pv-caret">{open() ? "▾" : "▸"}</span>
                    <span class="pv-project-name">{p.name}</span>
                    <span class="pv-muted">
                      {plural(p.sessions.length, "session")}
                      {p.workspaces.size > 1 ? ` · ${p.workspaces.size} worktrees` : ""}
                    </span>
                  </span>
                  <span />
                  <span class="pv-num pv-muted">{cost() > 0 ? f.usd(cost()) : ""}</span>
                  <span class="pv-num pv-muted">{ago(p.sessions[0]!.modified, props.now)}</span>
                </button>
                <Show when={open()}>
                  <ul class="pv-rows pv-nested">
                    <For each={p.sessions}>{(s) => <Row session={s} now={props.now} workspace />}</For>
                  </ul>
                </Show>
              </li>
            )
          }}
        </For>
      </ul>
    </section>
  )
}

function Chip(props: { readonly cwd: string; readonly workspace?: boolean }) {
  const p = () => projectOf(props.cwd)
  return (
    <span class="pv-chip" title={tilde(props.cwd)}>
      {props.workspace ? p().workspace : p().name}
      <Show when={!props.workspace && p().workspace}>
        <span class="pv-chip-sub"> · {p().workspace}</span>
      </Show>
    </span>
  )
}

function Card(props: { readonly session: SessionSummary }) {
  const s = () => props.session
  const share = () => contextShare(s())
  return (
    <a class="pv-card" href={`#/s/${encodeURIComponent(s().id)}`}>
      <div class="pv-card-top">
        <span class="ocv-status ocv-status-live" />
        <Chip cwd={s().cwd} />
        <span class="pv-muted pv-card-state">{s().inFlight === "tools" ? "running tools" : "waiting on model"}</span>
      </div>
      <div class="pv-card-title">{titleOf(s())}</div>
      <Show when={s().context > 0}>
        <div class="pv-card-bar" title={share() !== undefined ? `${f.share(share()!, 1)} of the context window` : undefined}>
          <div style={{ width: `${Math.min(100, (share() ?? 0) * 100)}%` }} classList={{ "pv-warn": (share() ?? 0) >= 0.8 }} />
        </div>
      </Show>
      <div class="pv-card-meta">
        <Show when={s().context > 0}>
          <span>
            {f.tokens(s().context)} ctx{share() !== undefined ? ` · ${f.share(share()!, 1)}` : ""}
          </span>
        </Show>
        <Show when={s().cost > 0}>
          <span>{f.usd(s().cost)}</span>
        </Show>
        <span class="pv-card-model" title={s().model?.id}>
          {shortModel(s().model?.id)}
        </span>
      </div>
    </a>
  )
}

function Row(props: { readonly session: SessionSummary; readonly now: number; readonly project?: boolean; readonly workspace?: boolean }) {
  const s = () => props.session
  const showWorkspace = () => props.workspace && projectOf(s().cwd).workspace
  return (
    <li>
      <a class="pv-row" href={`#/s/${encodeURIComponent(s().id)}`}>
        <span class="pv-row-title" title={s().firstPrompt}>
          <Show when={props.project}>
            <Chip cwd={s().cwd} />
          </Show>
          <Show when={showWorkspace()}>
            <Chip cwd={s().cwd} workspace />
          </Show>
          <span class="pv-row-text">{titleOf(s())}</span>
        </span>
        <span class="pv-row-model" title={s().model ? `${s().model!.provider}/${s().model!.id}` : undefined}>
          {shortModel(s().model?.id)}
        </span>
        <span class="pv-num pv-muted">{s().cost > 0 ? f.usd(s().cost) : ""}</span>
        <span class="pv-num pv-muted" title={new Date(s().modified).toLocaleString()}>
          {ago(s().modified, props.now)}
        </span>
      </a>
    </li>
  )
}
