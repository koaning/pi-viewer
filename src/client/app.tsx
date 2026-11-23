import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import * as f from "../format"
import { fallbackKey, fallbackModel, pricedModels, setFallback } from "./catalog"
import { focusSearch, Home } from "./home"
import { helpOpen, plain, setHelpOpen, SHORTCUTS, typing } from "./keys"
import { createDashboard, createSessionStore } from "./store"
import { choice, cycle, mode } from "./theme"
import { Dashboard } from "./view/dashboard"

// Two pages on the hash: `#/` lists every session, `#/s/<id>` is one session's dashboard. The hash keeps them on one
// URL the server doesn't need to know about, and each tab can follow another session.

const route = () => {
  const hash = location.hash.replace(/^#/, "")
  const match = /^\/s\/(.+)$/.exec(hash)
  return match ? { page: "session" as const, id: decodeURIComponent(match[1]!) } : { page: "home" as const }
}

export function App() {
  const [current, setCurrent] = createSignal(route())
  const onHash = () => {
    setCurrent(route())
    window.scrollTo(0, 0)
  }
  window.addEventListener("hashchange", onHash)
  onCleanup(() => window.removeEventListener("hashchange", onHash))

  // The shortcuts every page has. The list's own (moving through it, grouping) are in home.tsx.
  const onKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) return
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
      event.preventDefault()
      setHelpOpen(false)
      focusSearch()
      if (current().page !== "home") location.hash = "#/"
      return
    }
    if (event.key === "Escape" && helpOpen()) {
      event.preventDefault()
      setHelpOpen(false)
      return
    }
    if (typing(event.target) || !plain(event)) return
    if (event.key === "?") {
      event.preventDefault()
      setHelpOpen(!helpOpen())
    } else if (event.key === "/") {
      event.preventDefault()
      focusSearch()
      if (current().page !== "home") location.hash = "#/"
    } else if (event.key === "t") {
      cycle()
    } else if (event.key === "Escape" && current().page === "session") {
      location.hash = "#/"
    }
  }
  window.addEventListener("keydown", onKey)
  onCleanup(() => window.removeEventListener("keydown", onKey))
  createEffect(() => {
    document.documentElement.dataset.mode = mode()
    document.documentElement.style.colorScheme = mode()
  })

  return (
    <div class="pv-page">
      <nav class="pv-nav">
        <a class="pv-brand" href="#/">
          <span class="pv-logo">π</span> pi-viewer
        </a>
        <div class="pv-nav-end">
          <button class="pv-theme" onClick={() => setHelpOpen(!helpOpen())} title="Keyboard shortcuts (?)">
            ? shortcuts
          </button>
          <button class="pv-theme" onClick={cycle} title="Theme: system, light or dark (t)">
            {{ system: "◐ system", light: "☀ light", dark: "☾ dark" }[choice()]}
          </button>
        </div>
      </nav>
      <Show when={helpOpen()}>
        <Help />
      </Show>
      <Switch>
        <Match when={current().page === "home"}>
          <Home />
        </Match>
        <Match when={current().page === "session" && (current() as { id: string }).id}>{(id) => <SessionPage id={id()} />}</Match>
      </Switch>
    </div>
  )
}

function SessionPage(props: { readonly id: string }) {
  const store = createSessionStore(() => props.id)
  const dashboard = createDashboard(store)
  createEffect(() => {
    const title = dashboard().root?.title
    document.title = `${dashboard().root?.running ? "● " : ""}${title ? f.firstLine(title, 50) : "Session"} · pi-viewer`
  })
  onCleanup(() => (document.title = "pi-viewer"))
  const cwd = () => dashboard().summary?.cwd ?? dashboard().header?.cwd
  // Only worth offering when something has no price, or a stand-in is already picked.
  const unpriced = () => {
    const cost = dashboard().root?.totals.cost
    return !!fallbackKey() || (!!cost && (cost.kind === "none" || !!cost.partial || cost.kind === "fallback"))
  }
  return (
    <div class="pv-session">
      <div class="pv-crumbs">
        <a href="#/">All sessions</a>
        <Show when={cwd()}>
          <span class="pv-sep">/</span>
          <span class="pv-cwd" title={cwd()}>
            {cwd()}
          </span>
        </Show>
        <Show when={dashboard().summary?.parentSession}>
          <span class="pv-muted" title={dashboard().summary!.parentSession}>
            · forked
          </span>
        </Show>
      </div>
      <Dashboard
        dashboard={dashboard}
        fallbackName={() => fallbackModel()?.name}
        mode={mode}
        pricing={
          <Show when={unpriced()}>
            <PricePicker />
          </Show>
        }
      />
    </div>
  )
}

const rate = (n: number) => `$${n < 1 ? n.toFixed(2).replace(/0$/, "") : n % 1 ? n.toFixed(2) : n}`

/** Picks the model whose prices stand in for models without one (local models, mostly). */
function PricePicker() {
  const groups = createMemo(() => {
    const byProvider = new Map<string, ReturnType<typeof pricedModels>>()
    for (const m of pricedModels()) byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), m])
    return [...byProvider].sort((a, b) => a[0].localeCompare(b[0]))
  })
  return (
    <label class="pv-price" title="Estimate the cost of models without a price at another model's prices">
      <span class="ocv-link">{fallbackModel() ? `Unpriced as ${fallbackModel()!.name}` : "Price unpriced models…"}</span>
      <select value={fallbackKey()} onChange={(event) => setFallback(event.currentTarget.value)}>
        <option value="">Don't estimate unpriced models</option>
        <For each={groups()}>
          {([provider, models]) => (
            <optgroup label={provider}>
              <For each={models}>
                {(m) => (
                  <option value={`${m.provider}/${m.id}`}>
                    {m.name} · {rate(m.cost![0]!.input)}/M in · {rate(m.cost![0]!.output)}/M out
                  </option>
                )}
              </For>
            </optgroup>
          )}
        </For>
      </select>
    </label>
  )
}

/** The shortcuts, in a panel over the page. */
function Help() {
  return (
    <div class="pv-help-backdrop" onClick={() => setHelpOpen(false)}>
      <div class="pv-help" role="dialog" aria-label="Keyboard shortcuts" onClick={(event) => event.stopPropagation()}>
        <div class="pv-help-head">
          <h2>Keyboard shortcuts</h2>
          <button class="pv-theme" onClick={() => setHelpOpen(false)} title="Close (Esc)">
            ✕
          </button>
        </div>
        <table>
          <tbody>
            <For each={SHORTCUTS}>
              {(s) => (
                <tr>
                  <td>
                    <For each={s.keys}>
                      {(key, i) => (
                        <>
                          {i() > 0 ? <span class="pv-muted"> or </span> : ""}
                          <kbd class="pv-kbd">{key}</kbd>
                        </>
                      )}
                    </For>
                  </td>
                  <td>
                    {s.what}
                    <Show when={s.where}>
                      <span class="pv-muted"> · in the {s.where}</span>
                    </Show>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </div>
  )
}
