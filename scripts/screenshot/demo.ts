import { mkdirSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { session } from "../../test/fixtures"

// A made-up session for the README's screenshots: four prompts, a handful of tools, prompt caching. Its token counts
// follow from its own text (≈ 4 characters a token over a 6k-token system prompt), so the dashboard's estimate holds.

const SYSTEM = 6000
const PRICE = { input: 3, output: 15, read: 0.3, write: 3.75 } // Claude Sonnet 4.5, $ per million

type Tool = { name: string; args: Record<string, unknown>; output: string; ms: number; error?: boolean }
type Request = { think?: number; text?: string; tools?: Tool[]; ms: number }
type Prompt = { text: string; gap: number; requests: Request[] }

const lorem = (n: number) => "const value = compute(input) // ".repeat(Math.ceil(n / 32)).slice(0, n)

const PROMPTS: Prompt[] = [
  {
    text: "Add a dark mode toggle to the settings page and remember the choice.",
    gap: 0,
    requests: [
      { think: 900, ms: 4200, tools: [{ name: "read", args: { path: "src/settings/page.tsx" }, output: lorem(9000), ms: 40 }, { name: "read", args: { path: "src/theme.ts" }, output: lorem(3200), ms: 30 }] },
      { think: 400, ms: 3800, tools: [{ name: "bash", args: { command: "rg -n 'theme' src --type ts" }, output: lorem(2400), ms: 310 }] },
      { ms: 9200, text: "", tools: [{ name: "edit", args: { path: "src/settings/page.tsx", oldText: lorem(300), newText: lorem(900) }, output: "Applied 1 edit", ms: 25 }] },
      { ms: 5600, tools: [{ name: "write", args: { path: "src/settings/useTheme.ts", content: lorem(1400) }, output: "Wrote 41 lines", ms: 20 }] },
      { ms: 3100, text: "Added a toggle to Settings → Appearance. The choice is saved in localStorage and applied before first paint." },
    ],
  },
  {
    text: "Also add a 'system' option that follows the OS setting.",
    gap: 180_000,
    requests: [
      { think: 600, ms: 5200, tools: [{ name: "read", args: { path: "src/settings/useTheme.ts" }, output: lorem(1500), ms: 20 }] },
      { ms: 7800, tools: [{ name: "edit", args: { path: "src/settings/useTheme.ts", oldText: lorem(400), newText: lorem(1100) }, output: "Applied 1 edit", ms: 30 }] },
      { ms: 4100, tools: [{ name: "bash", args: { command: "bun run typecheck" }, output: lorem(200), ms: 6400 }] },
      { ms: 2900, text: "Done: 'system' follows prefers-color-scheme and updates live when the OS switches." },
    ],
  },
  {
    text: "Commit this.",
    gap: 240_000,
    requests: [
      { ms: 3300, tools: [{ name: "bash", args: { command: "git add -A && git commit -m 'Settings: dark mode toggle'" }, output: lorem(300), ms: 900 }] },
      { ms: 2100, text: "Committed as 3f2c1ab." },
    ],
  },
  {
    text: "CI fails on the settings snapshot test. Can you look into it?",
    gap: 300_000,
    requests: [
      { think: 1200, ms: 6100, tools: [{ name: "bash", args: { command: "bun test src/settings" }, output: lorem(4200), ms: 8500, error: true }] },
      { think: 700, ms: 5400, tools: [{ name: "read", args: { path: "src/settings/__snapshots__/page.test.tsx.snap" }, output: lorem(7000), ms: 35 }] },
      { ms: 6800, tools: [{ name: "bash", args: { command: "bun test src/settings -u" }, output: lorem(600), ms: 7900 }] },
      { ms: 3400, text: "The snapshot predated the toggle. Updated it; all 48 settings tests pass." },
    ],
  },
]

export function writeDemo(dir: string, now = Date.UTC(2026, 10, 23, 10, 12)) {
  const s = session("/Users/you/code/acme-app")
  let t = now - 40 * 60_000
  let chars = 0
  let cached = 0
  s.model("anthropic", "claude-sonnet-4-5", t)
  s.system(t, "x".repeat(SYSTEM * 4))
  s.name("Dark mode for settings", t)
  for (const prompt of PROMPTS) {
    t += prompt.gap + 2000
    s.user(t, prompt.text)
    chars += prompt.text.length
    for (const r of prompt.requests) {
      const context = SYSTEM + Math.round(chars / 4)
      const callChars = (r.tools ?? []).reduce((sum, tool) => sum + JSON.stringify(tool.args).length + tool.name.length, 0)
      const reasoning = Math.round((r.think ?? 0) / 4)
      const output = reasoning + Math.round(((r.text?.length ?? 0) + callChars) / 4) + 8
      const read = Math.min(cached, context)
      const input = context - read
      const write = 0
      const cost = {
        input: (input * PRICE.input) / 1e6,
        output: (output * PRICE.output) / 1e6,
        cacheRead: (read * PRICE.read) / 1e6,
        cacheWrite: (write * PRICE.write) / 1e6,
      }
      const start = t + 300
      const end = start + r.ms
      let at = end
      s.request({
        start,
        end,
        durationMs: r.ms,
        usage: { input, output, reasoning, cacheRead: read, cacheWrite: write, cost: { ...cost, total: cost.input + cost.output + cost.cacheRead + cost.cacheWrite } },
        thinking: r.think ? "x".repeat(r.think) : undefined,
        text: r.text,
        tools: (r.tools ?? []).map((tool) => {
          at += tool.ms + 40
          return { name: tool.name, args: tool.args, result: { at, durationMs: tool.ms, output: tool.output, error: tool.error } }
        }),
      })
      t = at
      cached = context
      chars += (r.think ?? 0) + (r.text?.length ?? 0) + callChars + (r.tools ?? []).reduce((sum, tool) => sum + tool.output.length, 0)
    }
  }
  const project = join(dir, "--Users-you-code-acme-app--")
  mkdirSync(project, { recursive: true })
  const path = join(project, "2026-11-23T09-32-00-000Z_01a2demo-0000-7000-8000-000000000001.jsonl")
  writeFileSync(path, s.jsonl())
  return path
}

type Other = {
  cwd: string
  ago: number
  prompts: string[]
  model?: string
  cost?: number
  /** Its last request's tool call is still going. */
  running?: boolean
  /** Its last prompt has no reply yet. */
  waiting?: boolean
}

// The rest of the made-up session list, for the home page's screenshot. Times count back from the real now, since the
// list goes by when each file last changed.
const OTHERS: Other[] = [
  { cwd: "/Users/you/code/acme-app", ago: 0, prompts: ["Make the settings page keyboard-navigable"], running: true, cost: 0.04 },
  { cwd: "/Users/you/code/blog", ago: 0, prompts: ["Draft a post about context windows", "Add a chart of context use per request"], waiting: true, cost: 0.18 },
  { cwd: "/Users/you/conductor/workspaces/acme-app/lisbon", ago: 3 * 3600_000, prompts: ["Upgrade Vite to 7 and fix the build", "Now the dev server", "Commit"], cost: 0.21 },
  { cwd: "/Users/you/conductor/workspaces/acme-app/osaka", ago: 5 * 3600_000, prompts: ["Why does the login form flash on load?", "Try the CSS fix"], model: "gpt-5.5", cost: 0.12 },
  { cwd: "/Users/you/code/blog", ago: 26 * 3600_000, prompts: ["Outline the context windows post", "Shorter intro"], cost: 0.09 },
  { cwd: "/Users/you/code/blog", ago: 3 * 86_400_000, prompts: ["Fix the RSS feed dates", "And the sitemap"], model: "qwen3-coder:30b" },
  { cwd: "/Users/you/code/infra", ago: 12 * 86_400_000, prompts: ["Why is the staging deploy failing?", "Roll it back"], cost: 0.33 },
  ...[1, 2, 3].map((i) => ({ cwd: "/Users/you/code/acme-app", ago: i * 3600_000, prompts: ["Generate a concise title for this coding-agent conversation."], model: "claude-haiku-4-5" })),
]

export function writeOthers(dir: string, now = Date.now()) {
  OTHERS.forEach((o, i) => {
    const start = now - o.ago - o.prompts.length * 120_000
    const s = session(o.cwd)
    s.header.timestamp = new Date(start).toISOString()
    s.model("anthropic", o.model ?? "claude-sonnet-4-5", start)
    o.prompts.forEach((text, n) => {
      const at = start + n * 120_000
      s.user(at, text)
      if (o.waiting && n === o.prompts.length - 1) return
      const tools = o.running && n === o.prompts.length - 1 ? [{ name: "bash", args: { command: "bun test" } }] : []
      s.request({
        start: at + 500,
        end: at + 9000,
        model: o.model ?? "claude-sonnet-4-5",
        usage: { input: 8000 + n * 3000, output: 300 },
        cost: (o.cost ?? 0) / o.prompts.length,
        text: tools.length ? undefined : "Done.",
        tools,
      })
    })
    const project = join(dir, `--${o.cwd.replace(/^\//, "").replaceAll("/", "-")}--`)
    mkdirSync(project, { recursive: true })
    const path = join(project, `${new Date(start).toISOString().replace(/[:.]/g, "-")}_01a2demo-0000-7000-8000-00000000010${i}.jsonl`)
    writeFileSync(path, s.jsonl())
    const modified = new Date(now - o.ago)
    utimesSync(path, modified, modified)
  })
}
