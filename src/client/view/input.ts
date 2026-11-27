/** A tool call's input as fields to read, not JSON to decode: strings as they are, a shell command a step a line. */

export interface InputField {
  readonly key: string
  /** The argument as given. */
  readonly value: unknown
  readonly text: string
  /** Shown as its own block (long, multi-line, a command or code) rather than inline. */
  readonly block: boolean
}

/** The arguments that say what a call does, shown first. */
const MAIN = ["command", "path", "file_path", "pattern", "query", "url", "code"]

/**
 * Breaks a one-line shell command after each top-level `&&`, `||` and `;`, so each step reads on its own line. Quotes,
 * escapes and `$( … )` are respected; a command already on several lines, or with a heredoc or `case`, stays as is.
 */
export const shellLines = (command: string): string => {
  if (command.includes("\n") || command.includes("<<") || /\bcase\b/.test(command)) return command
  const lines: string[] = []
  let line = ""
  let quote: string | undefined
  let depth = 0
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    line += c
    if (c === "\\" && quote !== "'") {
      line += command[++i] ?? ""
      continue
    }
    if (quote) {
      if (c === quote) quote = undefined
      continue
    }
    if (c === "'" || c === '"' || c === "`") quote = c
    else if (c === "(") depth++
    else if (c === ")") depth = Math.max(0, depth - 1)
    else if (depth === 0) {
      const two = c + (command[i + 1] ?? "")
      if (two === "&&" || two === "||") {
        line += command[++i]
        lines.push(line.trim())
        line = ""
      } else if (c === ";") {
        lines.push(line.trim())
        line = ""
      }
    }
  }
  if (line.trim()) lines.push(line.trim())
  return lines.join("\n")
}

const json = (value: unknown, indent?: number) => {
  try {
    return JSON.stringify(value, null, indent) ?? String(value)
  } catch {
    return String(value)
  }
}

export const inputFields = (tool: string, input: unknown): readonly InputField[] => {
  if (typeof input === "string") return [{ key: "", value: input, text: input, block: true }]
  if (!input || typeof input !== "object" || Array.isArray(input)) return [{ key: "", value: input, text: json(input, 2), block: true }]
  const entries = Object.entries(input as Record<string, unknown>)
  const rank = (key: string) => (MAIN.includes(key) ? MAIN.indexOf(key) : MAIN.length)
  return entries
    .map(([key, value], i) => ({ key, value, i }))
    .sort((a, b) => rank(a.key) - rank(b.key) || a.i - b.i)
    .map(({ key, value }) => {
      if (typeof value === "string") {
        const text = key === "command" && tool === "bash" ? shellLines(value) : value
        return { key, value, text, block: key === "command" || key === "code" || text.includes("\n") || text.length > 80 }
      }
      const short = json(value)
      return short.length <= 80 ? { key, value, text: short, block: false } : { key, value, text: json(value, 2), block: true }
    })
}

export type ShellKind = "cmd" | "flag" | "string" | "var" | "op" | "comment" | "text"
export interface ShellToken {
  readonly kind: ShellKind
  readonly text: string
}

const OPS = ["&&", "||", ">>", "2>&1", "&>", ";", "|", ">", "<", "&"]

/**
 * Splits a shell command into tokens to colour: the program each step runs, flags, quoted strings, variables,
 * operators and comments. Approximate, for reading: every character lands in exactly one token, so the text is unchanged.
 */
export const shellTokens = (command: string): readonly ShellToken[] => {
  const out: ShellToken[] = []
  const push = (kind: ShellKind, text: string) => {
    const last = out[out.length - 1]
    if (last && last.kind === kind && kind === "text") out[out.length - 1] = { kind, text: last.text + text }
    else out.push({ kind, text })
  }
  // The next word starts a step: at the beginning, and after an operator, `(` or a newline.
  let start = true
  let i = 0
  while (i < command.length) {
    const c = command[i]!
    if (c === " " || c === "\t") {
      push("text", c)
      i++
      continue
    }
    if (c === "\n") {
      push("text", c)
      start = true
      i++
      continue
    }
    if (c === "#" && (i === 0 || /\s/.test(command[i - 1]!))) {
      const end = command.indexOf("\n", i)
      const stop = end < 0 ? command.length : end
      push("comment", command.slice(i, stop))
      i = stop
      continue
    }
    const op = OPS.find((o) => command.startsWith(o, i))
    if (op) {
      push("op", op)
      i += op.length
      if (op !== ">" && op !== ">>" && op !== "<" && op !== "2>&1" && op !== "&>") start = true
      continue
    }
    if (c === "(" || c === ")") {
      push("op", c)
      i++
      start = c === "("
      continue
    }
    // A word: runs to whitespace or an operator, through quotes and escapes.
    let j = i
    const parts: ShellToken[] = []
    let plain = ""
    const flush = () => {
      if (plain) parts.push({ kind: "text", text: plain })
      plain = ""
    }
    while (j < command.length) {
      const d = command[j]!
      if (/\s/.test(d) || d === "(" || d === ")" || OPS.some((o) => o !== "&" && command.startsWith(o, j)) || d === "&") break
      if (d === "\\") {
        plain += command.slice(j, j + 2)
        j += 2
      } else if (d === "'" || d === '"') {
        flush()
        let k = j + 1
        while (k < command.length && command[k] !== d) k += d === '"' && command[k] === "\\" ? 2 : 1
        parts.push({ kind: "string", text: command.slice(j, k + 1) })
        j = k + 1
      } else if (d === "$") {
        flush()
        const m = /^\$(\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*|[0-9?@*#$!-])/.exec(command.slice(j))
        const text = m ? m[0] : "$"
        parts.push({ kind: "var", text })
        j += text.length
      } else {
        plain += d
        j++
      }
    }
    flush()
    const word = parts.map((p) => p.text).join("")
    if (start && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      // An assignment before the program, `FOO=1 cmd`: the program is still to come.
      for (const p of parts) push(p.kind, p.text)
    } else if (start && parts.length === 1 && parts[0]!.kind === "text") {
      push("cmd", word)
      start = false
    } else if (parts.length === 1 && parts[0]!.kind === "text" && /^--?[A-Za-z0-9]/.test(word)) {
      push("flag", word)
    } else {
      for (const p of parts) push(p.kind, p.text)
      start = false
    }
    i = j
  }
  return out
}
