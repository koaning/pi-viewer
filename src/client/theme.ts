import { createSignal } from "solid-js"

// Light or dark: the system's, unless picked here (remembered in this browser).

export type Choice = "system" | "light" | "dark"

const KEY = "pi-viewer:theme"
const stored = (): Choice => {
  try {
    const value = localStorage.getItem(KEY)
    return value === "light" || value === "dark" ? value : "system"
  } catch {
    return "system"
  }
}

const query = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : undefined
const [systemDark, setSystemDark] = createSignal(!!query?.matches)
query?.addEventListener("change", (event) => setSystemDark(event.matches))

const [choice, setChoiceSignal] = createSignal<Choice>(stored())

export { choice }

export const mode = (): "light" | "dark" => {
  const c = choice()
  return c === "system" ? (systemDark() ? "dark" : "light") : c
}

export const setChoice = (c: Choice) => {
  setChoiceSignal(c)
  try {
    if (c === "system") localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, c)
  } catch {
    // Private mode: it lasts for this page.
  }
}

/** system → light → dark → system. */
export const cycle = () => setChoice(choice() === "system" ? "light" : choice() === "light" ? "dark" : "system")
