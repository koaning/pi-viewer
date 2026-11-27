import { createResource, Show } from "solid-js"

/** The highlight.js language for a file, by its extension or name; undefined for anything else. */
export const languageOf = (path: string | undefined): string | undefined => {
  if (!path) return undefined
  const name = path.split(/[/\\]/).pop()!.toLowerCase()
  if (name === "dockerfile" || name === "makefile") return "bash"
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : ""
  return EXTENSIONS[ext]
}

const EXTENSIONS: Record<string, string> = {
  py: "python",
  pyi: "python",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonl: "json",
  css: "css",
  html: "xml",
  xml: "xml",
  svg: "xml",
  vue: "xml",
  md: "markdown",
  markdown: "markdown",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  cfg: "ini",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  rs: "rust",
  go: "go",
  sql: "sql",
  diff: "diff",
  patch: "diff",
}

/** Past this, highlighting costs more than it helps; the text shows plain. */
const MAX_HIGHLIGHT = 60_000

/**
 * Code in a `<pre>`, highlighted once highlight.js has loaded: as `language`, or, with `guess`, as whatever it most
 * looks like (left plain when that's unclear). Plain text until then, and for anything else.
 */
export function Code(props: { readonly text: string; readonly language?: string; readonly guess?: boolean; readonly class?: string }) {
  const [html] = createResource(
    () => ({ text: props.text, language: props.language, guess: props.guess }),
    async ({ text, language, guess }) => {
      if ((!language && !guess) || text.length > MAX_HIGHLIGHT) return undefined
      const { highlight } = await import("./highlighter")
      return highlight(text, language)
    },
  )
  return (
    <Show when={html()} fallback={<pre class={props.class}>{props.text}</pre>}>
      {(markup) => <pre class={`ocv-code ${props.class ?? ""}`} innerHTML={markup()} />}
    </Show>
  )
}
