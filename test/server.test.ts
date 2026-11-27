import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionEvent } from "../src/api"
import { costsOf } from "../src/server/catalog"
import { createApp } from "../src/server/http"
import { idOf, SessionFile, Tally } from "../src/server/sessions"
import { LineReader, parseLine } from "../src/server/tail"
import { SessionIndex } from "../src/server/watch"
import { session } from "./fixtures"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-viewer-"))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("LineReader", () => {
  test("returns appended lines, holding back one still being written", () => {
    const path = join(dir, "s.jsonl")
    writeFileSync(path, '{"a":1}\n{"b":')
    const reader = new LineReader(path)
    expect(reader.read().lines).toEqual(['{"a":1}'])
    expect(reader.read().lines).toEqual([])
    appendFileSync(path, '2}\n{"c":3}\n')
    expect(reader.read().lines).toEqual(['{"b":2}', '{"c":3}'])
  })

  test("keeps multi-byte characters split across reads whole", () => {
    const path = join(dir, "s.jsonl")
    const line = JSON.stringify({ text: "héllo π ✓" })
    const bytes = Buffer.from(`${line}\n`)
    writeFileSync(path, bytes.subarray(0, 12))
    const reader = new LineReader(path)
    expect(reader.read().lines).toEqual([])
    appendFileSync(path, bytes.subarray(12))
    expect(reader.read().lines).toEqual([line])
  })

  test("starts over when the file shrinks", () => {
    const path = join(dir, "s.jsonl")
    writeFileSync(path, '{"a":1}\n{"b":2}\n')
    const reader = new LineReader(path)
    reader.read()
    writeFileSync(path, '{"z":0}\n')
    expect(reader.read()).toEqual({ lines: ['{"z":0}'], reset: true })
  })
})

test("parseLine drops image data and skips lines that aren't entries", () => {
  const line = JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] } })
  expect(parseLine(line)).toEqual({ type: "message", message: { role: "user", content: [{ type: "image", mimeType: "image/png" }] } } as never)
  expect(parseLine("not json")).toBeUndefined()
  expect(parseLine("[1,2]")).toBeUndefined()
})

test("idOf takes the id from a session file's name", () => {
  expect(idOf("/x/2026-06-30T08-18-11-200Z_019f179b-7280.jsonl")).toBe("019f179b-7280")
})

describe("Tally", () => {
  const tally = (s: ReturnType<typeof session>) => {
    const t = new Tally()
    for (const line of s.jsonl().trim().split("\n")) t.add(parseLine(line)!)
    return t
  }

  test("sums cost, counts prompts and requests, and keeps the latest context", () => {
    const s = session("/work/app")
    s.name("Fix the tests")
    s.user(1000, "please fix")
    s.request({ start: 1100, end: 1200, usage: { input: 100, output: 5, cacheRead: 900 }, cost: 0.5, tools: [{ name: "bash", result: { at: 1300 } }] })
    s.request({ start: 1300, end: 1400, usage: { input: 50, output: 5, cacheRead: 1200 }, cost: 0.25 })
    const t = tally(s)
    const summary = t.summary("/x/a_ses.jsonl", 2000, 2000)
    expect(summary).toMatchObject({ id: "ses", cwd: "/work/app", name: "Fix the tests", firstPrompt: "please fix", prompts: 1, requests: 2, context: 1250 })
    expect(summary.cost).toBeCloseTo(0.75)
    expect(summary.running).toBe(false)
  })

  test("is running while a prompt or tool call waits, and only while the file is fresh", () => {
    const s = session()
    s.user(0, "go")
    expect(tally(s).summary("/x/a_b.jsonl", 1000, 2000)).toMatchObject({ running: true, inFlight: "model", live: true })
    s.request({ start: 10, end: 20, usage: { input: 1, output: 1 }, tools: [{ name: "bash" }] })
    expect(tally(s).inFlight).toBe("tools")
    expect(tally(s).summary("/x/a_b.jsonl", 0, 60 * 60_000)).toMatchObject({ running: false, live: false })
  })
})

describe("SessionFile", () => {
  test("sends a snapshot to a subscriber, then what pi appends", () => {
    const project = join(dir, "--work--")
    mkdirSync(project)
    const path = join(project, "2026-01-01T00-00-00-000Z_abc.jsonl")
    const s = session()
    s.user(0, "go")
    writeFileSync(path, s.jsonl())
    const file = new SessionFile(path)
    file.refresh()
    const events: SessionEvent[] = []
    const off = file.subscribe((e) => events.push(e))
    expect(events[0]).toMatchObject({ type: "snapshot", header: { id: "ses-1" } })
    expect((events[0] as unknown as { entries: unknown[] }).entries).toHaveLength(1)

    appendFileSync(path, JSON.stringify({ type: "session_info", id: "zz", parentId: null, timestamp: new Date().toISOString(), name: "Named" }) + "\n")
    file.refresh()
    expect(events.map((e) => e.type)).toEqual(["snapshot", "append", "summary"])
    expect(file.summary().name).toBe("Named")
    off()
  })
})

test("costsOf turns pi's prices and tiers into context tiers", () => {
  expect(costsOf({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, tiers: [{ inputTokensAbove: 200_000, input: 6 }] })).toEqual([
    { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
    { input: 6, output: 15, cache: { read: 0.3, write: 3.75 }, tier: { type: "context", size: 200_000 } },
  ])
  expect(costsOf(undefined)).toBeUndefined()
})

describe("the shared server's routes", () => {
  const serve = async (onHold?: (delta: 1 | -1) => void) => {
    const app = createApp({ index: new SessionIndex(dir), catalog: async () => [], version: "9.9.9", onHold })
    await new Promise<void>((done) => app.listen(0, "127.0.0.1", done))
    const { port } = app.address() as { port: number }
    return { app, base: `http://127.0.0.1:${port}` }
  }

  test("/api/hello names the app", async () => {
    const { app, base } = await serve()
    expect(await (await fetch(`${base}/api/hello`)).json()).toEqual({ app: "pi-viewer", version: "9.9.9" })
    app.close()
  })

  test("a session's stream waits for a file pi hasn't written yet", async () => {
    const index = new SessionIndex(dir).start()
    const app = createApp({ index, catalog: async () => [] })
    await new Promise<void>((done) => app.listen(0, "127.0.0.1", done))
    const { port } = app.address() as { port: number }
    const abort = new AbortController()
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/new-one/stream`, { signal: abort.signal })
    const reader = res.body!.getReader()
    let text = ""
    const until = async (type: string) => {
      while (!text.includes(`"type":"${type}"`)) text += new TextDecoder().decode((await reader.read()).value)
    }
    await until("waiting")
    mkdirSync(join(dir, "project"))
    const s = session("/work/app")
    s.user(1000, "hi")
    writeFileSync(join(dir, "project", "2026-11-26T10-00-00-000Z_new-one.jsonl"), s.jsonl())
    await until("snapshot")
    abort.abort()
    index.stop()
    app.closeAllConnections()
    app.close()
  })

  test("/api/hold counts a holder while it's connected", async () => {
    const deltas: number[] = []
    const { app, base } = await serve((delta) => deltas.push(delta))
    const abort = new AbortController()
    const res = await fetch(`${base}/api/hold`, { signal: abort.signal })
    expect(res.headers.get("content-type")).toBe("text/event-stream")
    expect(deltas).toEqual([1])
    abort.abort()
    await res.body?.cancel().catch(() => undefined)
    for (let i = 0; i < 50 && deltas.length < 2; i++) await Bun.sleep(10)
    expect(deltas).toEqual([1, -1])
    app.closeAllConnections()
    app.close()
  })
})
