import type { Cost } from "./pricing"

export const duration = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0) return "0s"
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 10) return `${s.toFixed(1)}s`
  if (s < 60) return `${Math.round(s)}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(Math.round(s % 60)).padStart(2, "0")}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`
}

export const tokens = (n: number): string => {
  if (n < 1000) return String(Math.round(n))
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  if (n < 10_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export const usd = (value: number): string => {
  if (value === 0) return "$0"
  if (value < 0.01) return `$${value.toFixed(4)}`
  if (value < 100) return `$${value.toFixed(2)}`
  return `$${Math.round(value)}`
}

/** A cost with how sure it is: reported as is, estimates with ≈, nothing priced as "n/a". */
export const cost = (c: Cost): string => {
  if (c.kind === "none") return "n/a"
  return `${c.kind === "reported" ? "" : "≈"}${usd(c.value)}${c.partial ? "+" : ""}`
}

export const costNote = (c: Cost, fallback?: string): string => {
  const base =
    c.kind === "reported"
      ? "As pi recorded it"
      : c.kind === "estimated"
        ? "Estimated: tokens × catalog price (pi recorded $0)"
        : c.kind === "fallback"
          ? `Estimated at ${fallback ?? "the fallback model"}'s prices`
          : "No price known for this model"
  return c.partial ? `${base}; some requests had no price and are left out` : base
}

export const percent = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "–")

/** A percentage with a decimal below 10%, so small shares of a big window still read (0.6%, not 1%). */
export const share = (part: number, whole: number) => {
  if (!(whole > 0)) return "–"
  const p = (part / whole) * 100
  if (p <= 0) return "0%"
  if (p < 0.1) return "<0.1%"
  return p < 10 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`
}

export const clock = (time: number) =>
  new Date(time).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })

/**
 * Removes multi-line `<tag>…</tag>` blocks that tools and apps wrap around prompts, e.g. injected instructions.
 * Inline markup on one line stays. A skill pi expanded into the prompt stays as the command that asked for it,
 * `/name`.
 */
export const stripBlocks = (text: string) => {
  let out = text
  for (let i = 0; i < 5; i++) {
    const next = out.replace(/<([A-Za-z][\w-]*)(\s[^>]*)?>([\s\S]*?)<\/\1>/g, (block, tag: string, attrs: string | undefined, inner: string) => {
      if (!inner.includes("\n")) return block
      const skill = tag === "skill" && /\bname="([^"]+)"/.exec(attrs ?? "")?.[1]
      return skill ? ` /${skill} ` : " "
    })
    if (next === out) break
    out = next
  }
  return out
}

export const firstLine = (text: string, max = 120) => {
  const line = stripBlocks(text).replace(/\s+/g, " ").trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}
