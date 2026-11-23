import { describe, expect, test } from "bun:test"
import { contextBreakdown, contextTimeline, producedOf, toolStats, totalsOf, turnsOf } from "../src/model"
import { activeBranch } from "../src/pi/branch"
import { normalize } from "../src/pi/normalize"
import { session } from "./fixtures"

const x = (n: number) => "x".repeat(n)
const transcript = (s: ReturnType<typeof session>, running = false) => normalize(activeBranch(s.entries).entries, { running }).messages

describe("turnsOf", () => {
  test("splits at prompts, folds tool results into their request, and times model and tools apart", () => {
    const s = session()
    s.model("anthropic", "claude-sonnet-4-5")
    s.system(900)
    s.user(1000, "first")
    s.request({
      start: 1100,
      end: 1600,
      usage: { input: 100, output: 10 },
      tools: [{ name: "bash", args: { command: "ls -la" }, result: { at: 2600, durationMs: 1000, output: "a\nb" } }],
    })
    s.request({ start: 2600, end: 3000, usage: { input: 10, output: 20, cacheRead: 100 }, text: "done" })
    s.user(5000, "second")
    s.request({ start: 5050, end: 5500, usage: { input: 5, output: 5, cacheRead: 200 } })

    const turns = turnsOf(transcript(s), { now: 9999 })
    expect(turns).toHaveLength(2)
    const [a, b] = turns
    expect(a!.prompt).toBe("first")
    expect(a!.steps).toHaveLength(2)
    expect(a!.markers).toHaveLength(0) // the opening system prompt is the baseline, not a marker
    expect(a!.ms).toBe(2000)
    expect(a!.modelMs).toBe(500 + 400)
    expect(a!.toolMs).toBe(1000)
    expect(a!.otherMs).toBe(100)
    expect(a!.toolCalls).toBe(1)
    expect(a!.peakContext).toBe(110)
    expect(a!.steps[0]!.tools[0]).toMatchObject({ name: "bash", summary: "ls -la", ms: 1000, outputChars: 3, status: "completed" })
    expect(b!.usage).toEqual({ input: 5, output: 5, reasoning: 0, cacheRead: 200, cacheWrite: 0 })
    expect(totalsOf(turns)).toMatchObject({ turns: 2, steps: 3, toolCalls: 1, wallMs: 4500, toolMs: 1000 })
  })

  test("uses durationMs for the model's time when pi records it", () => {
    const s = session()
    s.user(0, "go")
    s.request({ start: 100, end: 900, durationMs: 500, usage: { input: 1, output: 1 } })
    const step = turnsOf(transcript(s), { now: 0 })[0]!.steps[0]!
    expect(step.modelMs).toBe(500)
  })

  test("without a tool's durationMs, the tool runs from the end of the reply to its result", () => {
    const s = session()
    s.user(0, "go")
    s.request({ start: 100, end: 500, usage: { input: 1, output: 1 }, tools: [{ name: "read", args: { path: "a.ts" }, result: { at: 1900 } }] })
    const [turn] = turnsOf(transcript(s), { now: 0 })
    expect(turn!.modelMs).toBe(400)
    expect(turn!.toolMs).toBe(1400)
    expect(turn!.steps[0]!.tools[0]).toMatchObject({ ms: 1400, summary: "a.ts" })
  })

  test("a running session's prompt without a reply gets a pending request that ticks", () => {
    const s = session()
    s.model("anthropic", "claude-sonnet-4-5")
    s.user(0, "go")
    const live = turnsOf(transcript(s, true), { now: 5000, running: true })[0]!
    expect(live.running).toBe(true)
    expect(live.steps).toHaveLength(1)
    expect(live.steps[0]).toMatchObject({ pending: true, running: true, modelMs: 5000 })
    expect(live.ms).toBe(5000)
    expect(live.cost.partial).toBeUndefined()
    // Not running: nothing is out, and the turn ends at its prompt.
    const idle = turnsOf(transcript(s), { now: 5000 })[0]!
    expect(idle.steps).toHaveLength(0)
    expect(idle.running).toBe(false)
  })

  test("a tool without a result runs while the session does", () => {
    const s = session()
    s.user(0, "go")
    s.request({ start: 10, end: 100, usage: { input: 1, output: 1 }, tools: [{ name: "bash", args: { command: "sleep 9" } }] })
    const messages = transcript(s, true)
    expect(messages.some((m) => m.type === "assistant" && m.pending)).toBe(false)
    const step = turnsOf(messages, { now: 3000, running: true })[0]!.steps[0]!
    expect(step.running).toBe(true)
    expect(step.tools[0]).toMatchObject({ status: "running", ms: 2900 })
    expect(step.toolMs).toBe(2900)
  })

  test("errors and aborts end a request and say why", () => {
    const s = session()
    s.user(0, "go")
    s.request({ start: 10, end: 300, usage: { input: 1, output: 0 }, stop: "error", error: "429 rate limited" })
    const step = turnsOf(transcript(s), { now: 0 })[0]!.steps[0]!
    expect(step.error).toBe("429 rate limited")
    expect(step.running).toBe(false)
  })

  test("a note just before a prompt goes with that prompt, not the idle turn before it", () => {
    const s = session()
    s.user(0, "yo")
    s.request({ start: 10, end: 2000, usage: { input: 1, output: 1 } })
    s.bash(37_000, "git status", "clean")
    s.user(37_001, "next")
    s.request({ start: 37_010, end: 40_000, usage: { input: 1, output: 1 } })
    const turns = turnsOf(transcript(s), { now: 0 })
    expect(turns[0]!.ms).toBe(2000)
    expect(turns[0]!.markers).toHaveLength(0)
    expect(turns[1]!.markers.map((m) => m.kind)).toEqual(["shell"])
  })

  test("compactions, cache warming and tools' own model use count toward cost", () => {
    const s = session()
    s.user(0, "go")
    s.request({
      start: 1,
      end: 2,
      usage: { input: 10, output: 1 },
      cost: 1,
      tools: [{ name: "subagent", result: { at: 9, usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: { input: 0.2, output: 0.3, cacheRead: 0, cacheWrite: 0, total: 0.5 } } } }],
    })
    s.compaction(20, "sum", undefined, { input: 1000, output: 100 }, 0.25)
    s.usageEntry(30, { cacheRead: 5000 }, 0.125)
    s.user(40, "more")
    const turns = turnsOf(transcript(s), { now: 0 })
    expect(turns[0]!.cost.value).toBeCloseTo(1.75)
    expect(turns[0]!.toolCost.value).toBeCloseTo(0.5)
    expect(turns[0]!.markers.map((m) => m.kind)).toEqual(["compaction"])
    expect(turns[1]!.markers.map((m) => m.kind)).toEqual(["usage"])
    expect(totalsOf(turns).cost.value).toBeCloseTo(1.875)
  })

  test("pi's reasoning count comes out of its output, which includes it", () => {
    const s = session()
    s.user(0, "go")
    s.request({ start: 0, end: 1000, durationMs: 1000, usage: { input: 10, output: 100, reasoning: 40 }, thinking: x(100), text: x(100) })
    const step = turnsOf(transcript(s), { now: 0 })[0]!.steps[0]!
    expect(step.usage).toMatchObject({ output: 60, reasoning: 40 })
    // pi doesn't time thinking: it gets the reasoning share of the model's time, from the start.
    expect(step.thinkingMs).toBe(400)
  })

  test("follows the active branch of the tree", () => {
    const s = session()
    const first = s.user(0, "first")
    s.request({ start: 1, end: 2, usage: { input: 1, output: 1 }, text: "old reply" })
    s.at(first)
    s.request({ start: 10, end: 20, usage: { input: 2, output: 2 }, text: "new reply" })
    const branch = activeBranch(s.entries)
    expect(branch.abandoned).toBe(1)
    const turns = turnsOf(normalize(branch.entries).messages, { now: 0 })
    expect(turns[0]!.steps.map((st) => st.text)).toEqual(["new reply"])
  })
})

describe("contextBreakdown", () => {
  test("anchors the system share on the first request and adds up to the measured total", () => {
    const s = session()
    s.system(0, x(20000))
    s.user(0, x(400)) // ~100 tokens
    s.request({
      start: 1,
      end: 2,
      usage: { input: 5100, output: 10 }, // 5000 system + 100 prompt
      text: x(400),
      tools: [{ name: "read", args: { path: "a" }, result: { at: 2, output: x(8000) } }],
    })
    s.request({ start: 3, end: 4, usage: { input: 300, output: 10, cacheRead: 7000 } })
    const breakdown = contextBreakdown(transcript(s))!
    expect(breakdown.total).toBe(7300)
    expect(breakdown.shares.find((sh) => sh.bucket.kind === "system")!.tokens).toBe(5000)
    const sum = breakdown.shares.reduce((acc, sh) => acc + sh.tokens, 0)
    expect(Math.abs(sum - breakdown.total)).toBeLessThanOrEqual(breakdown.shares.length)
    const read = breakdown.shares.find((sh) => sh.bucket.kind === "tool" && sh.bucket.name === "read")!
    expect(read.tokens).toBeGreaterThan(1500)
  })

  test("starts over after a compaction, from its summary", () => {
    const s = session()
    s.user(0, x(40000))
    s.request({ start: 1, end: 2, usage: { input: 20000, output: 10 } })
    s.compaction(3, x(2000))
    s.user(4, x(400))
    s.request({ start: 5, end: 6, usage: { input: 5600, output: 10 } })
    const breakdown = contextBreakdown(transcript(s))!
    expect(breakdown.total).toBe(5600)
    expect(breakdown.shares.find((sh) => sh.bucket.kind === "system")!.tokens).toBe(5000)
    expect(breakdown.shares.find((sh) => sh.bucket.kind === "summary")!.tokens).toBeGreaterThan(0)
  })

  test("is undefined before any request reports tokens", () => {
    const s = session()
    s.user(0, "hi")
    expect(contextBreakdown(transcript(s))).toBeUndefined()
  })
})

describe("contextTimeline", () => {
  test("gives every request its makeup, adding up to its measured context", () => {
    const s = session()
    s.user(0, x(400))
    s.request({
      start: 1,
      end: 2,
      usage: { input: 5100, output: 50 },
      text: x(40),
      tools: [{ name: "bash", args: { command: "ls" }, result: { at: 2, output: x(4000) } }],
    })
    s.user(3, x(40))
    s.request({ start: 4, end: 5, usage: { input: 200, output: 20, reasoning: 10, cacheRead: 6000 }, thinking: x(80) })
    const { points, compactions } = contextTimeline(transcript(s))
    expect(compactions).toEqual([])
    expect(points.map((p) => [p.turn, p.total])).toEqual([
      [0, 5100],
      [1, 6200],
    ])
    for (const point of points) expect(Object.values(point.parts).reduce((a, b) => a + b, 0)).toBeCloseTo(point.total, 5)
    expect(points[0]!.parts.system).toBe(5000)
    expect(points[0]!.parts["tool:bash"]).toBeUndefined()
    expect(points[1]!.parts.system).toBe(5000)
    expect(points[1]!.parts["tool:bash"]).toBeGreaterThan(900)
    expect(points[0]!.produced.text + points[0]!.produced.calls).toBeCloseTo(50, 5)
    expect(points[1]!.produced.reasoning).toBe(10)
  })

  test("a compaction keeps its kept range, and marks where", () => {
    const s = session()
    s.user(0, x(40000))
    s.request({ start: 1, end: 2, usage: { input: 15000, output: 1 } })
    const kept = s.user(3, x(4000))
    s.request({ start: 4, end: 5, usage: { input: 16000, output: 1 } })
    s.compaction(6, x(400), kept)
    s.user(7, x(40))
    s.request({ start: 8, end: 9, usage: { input: 6000, output: 1 } })
    const { points, compactions } = contextTimeline(transcript(s))
    expect(compactions).toEqual([2])
    const after = points[2]!
    // Measured again after the compaction, net of the summary (100), the kept prompt (1000) and the new one (10).
    expect(after.parts.system).toBe(6000 - 100 - 1000 - 10)
    expect(after.parts.summary).toBeCloseTo(100, 5)
  })

  test("leaves !! commands out of the context", () => {
    const s = session()
    s.user(0, x(400))
    s.request({ start: 1, end: 2, usage: { input: 5100, output: 1 } })
    s.bash(3, "cat big", x(40000), true)
    s.bash(4, "ls", x(400))
    s.request({ start: 5, end: 6, usage: { input: 5300, output: 1 } })
    const { points } = contextTimeline(transcript(s))
    expect(points[1]!.parts.user).toBeCloseTo(300, 0)
  })

  test("numbers turns as turnsOf does, activity before the first prompt being turn 0", () => {
    const s = session()
    s.system(0)
    s.request({ start: 0, end: 1, usage: { input: 10, output: 1 } })
    s.user(2, "hi")
    s.request({ start: 3, end: 4, usage: { input: 20, output: 1 } })
    const messages = transcript(s)
    expect(contextTimeline(messages).points.map((p) => p.turn)).toEqual(turnsOf(messages, { now: 0 }).flatMap((t) => t.steps.map(() => t.index)))
  })
})

test("producedOf splits output by what it went to", () => {
  expect(producedOf({ output: 100, reasoning: 40, reasoningChars: 999, textChars: 300, callChars: 100 })).toEqual({ reasoning: 40, text: 75, calls: 25 })
  expect(producedOf({ output: 100, reasoning: 0, reasoningChars: 100, textChars: 100, callChars: 200 })).toEqual({ reasoning: 25, text: 25, calls: 50 })
  expect(producedOf({ output: 10, reasoning: 0, reasoningChars: 0, textChars: 0, callChars: 0 })).toEqual({ reasoning: 0, text: 10, calls: 0 })
})

test("toolStats sums calls, time, errors and output per tool", () => {
  const s = session()
  s.user(0, "go")
  s.request({
    start: 0,
    end: 10,
    usage: { input: 1, output: 1 },
    tools: [
      { name: "bash", result: { at: 40, durationMs: 30, output: x(400) } },
      { name: "bash", result: { at: 90, durationMs: 80, error: true, output: "boom" } },
      { name: "read", result: { at: 11, durationMs: 1, output: x(40) } },
    ],
  })
  const stats = toolStats(turnsOf(transcript(s), { now: 0 }))
  expect(stats.find((st) => st.name === "bash")).toEqual({ name: "bash", calls: 2, errors: 1, ms: 110, maxMs: 80, outputTokens: 101 })
  expect(stats.find((st) => st.name === "read")!.outputTokens).toBe(10)
})

test("reported costs keep pi's own split", () => {
  const s = session()
  s.user(0, "go")
  s.request({ start: 0, end: 1, usage: { input: 10, output: 1, cost: { input: 0.1, output: 0.3, cacheRead: 0.05, cacheWrite: 0.05, total: 0.5 } } })
  const step = turnsOf(transcript(s), { now: 0 })[0]!.steps[0]!
  expect(step.cost).toEqual({ value: 0.5, kind: "reported", split: { input: 0.1, output: 0.3, cacheRead: 0.05, cacheWrite: 0.05 } })
})
