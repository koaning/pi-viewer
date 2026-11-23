import { createSignal } from "solid-js"

// Keyboard shortcuts: what's shared between the pages, and the list they're shown in.

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
export const MOD = isMac ? "⌘" : "Ctrl"

/** The key goes to a text field or a picker, not to the page. */
export const typing = (target: EventTarget | null) => {
  const el = target as HTMLElement | null
  return !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))
}

/** A key without Cmd, Ctrl or Alt held. (Shift is fine: it makes `?`.) */
export const plain = (event: KeyboardEvent) => !event.metaKey && !event.ctrlKey && !event.altKey

export const [helpOpen, setHelpOpen] = createSignal(false)

export const SHORTCUTS: readonly { readonly keys: readonly string[]; readonly what: string; readonly where?: string }[] = [
  { keys: [`${MOD} K`, "/"], what: "Search sessions" },
  { keys: ["↓", "j"], what: "Next session", where: "list" },
  { keys: ["↑", "k"], what: "Previous session", where: "list" },
  { keys: ["Enter"], what: "Open it (from the search: the first match)", where: "list" },
  { keys: ["r"], what: "Group by day", where: "list" },
  { keys: ["p"], what: "Group by project", where: "list" },
  { keys: ["h"], what: "Show or hide one-shot sessions", where: "list" },
  { keys: ["Esc"], what: "Clear the search, or go back to the list" },
  { keys: ["t"], what: "Theme: system, light or dark" },
  { keys: ["?"], what: "These shortcuts" },
]
