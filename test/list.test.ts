import { describe, expect, test } from "bun:test"
import { ago, bucketOf, isOneShot, projectOf, shortModel, stamp, tilde, titleOf } from "../src/client/list"
import { stripBlocks } from "../src/format"

describe("projectOf", () => {
  test("folds Conductor's worktrees into their repository", () => {
    expect(projectOf("/Users/me/conductor/workspaces/webpi/accra-v1")).toEqual({
      key: "/Users/me/conductor/workspaces/webpi",
      name: "webpi",
      workspace: "accra-v1",
    })
    expect(projectOf("/Users/me/conductor/workspaces/webpi/accra-v1/src")).toMatchObject({ name: "webpi", workspace: "accra-v1" })
    expect(projectOf("/Users/me/Development/calmcards/.conductor/tokyo")).toEqual({
      key: "/Users/me/Development/calmcards",
      name: "calmcards",
      workspace: "tokyo",
    })
  })
  test("names other directories by their last segment, and home as ~", () => {
    expect(projectOf("/Users/me/Development/hastyplot")).toEqual({ key: "/Users/me/Development/hastyplot", name: "hastyplot" })
    expect(projectOf("/Users/me")).toEqual({ key: "/Users/me", name: "~" })
    expect(projectOf("/home/me/")).toMatchObject({ name: "~" })
    expect(projectOf("").name).toBe("(unknown directory)")
  })
})

test("tilde", () => {
  expect(tilde("/Users/me/code")).toBe("~/code")
  expect(tilde("/Users/me")).toBe("~")
  expect(tilde("/opt/x")).toBe("/opt/x")
})

test("shortModel drops the provider, tag and date", () => {
  expect(shortModel("deepseek/deepseek-v4-flash")).toBe("deepseek-v4-flash")
  expect(shortModel("lfm2.5-thinking:latest")).toBe("lfm2.5-thinking")
  expect(shortModel("claude-sonnet-4-5-20250929")).toBe("claude-sonnet-4-5")
  expect(shortModel("gpt-5.5")).toBe("gpt-5.5")
  expect(shortModel(undefined)).toBe("")
})

describe("titleOf", () => {
  test("prefers the session's name", () => {
    expect(titleOf({ name: "Dark mode", firstPrompt: "hi" })).toBe("Dark mode")
  })
  test("shows a skill as the command that asked for it", () => {
    const skill = '<skill name="marimo-pair" location="/x/SKILL.md">\nLots of\ninstructions\n</skill>'
    expect(titleOf({ firstPrompt: stripBlocks(skill) })).toBe("/marimo-pair")
    expect(titleOf({ firstPrompt: stripBlocks(`${skill}\n\nopen the notebook`) })).toBe("/marimo-pair open the notebook")
    // Cut off before its closing tag.
    expect(titleOf({ firstPrompt: '<skill name="marimo-pair" location="/Users/me/notebooks/.agents' })).toBe("/marimo-pair")
  })
  test("drops other tags left open at the start", () => {
    expect(titleOf({ firstPrompt: '<context path="/x"> fix the build' })).toBe("fix the build")
  })
  test("says so when there's no prompt", () => {
    expect(titleOf({})).toBe("(no prompt yet)")
  })
})

test("isOneShot", () => {
  expect(isOneShot({ prompts: 1, requests: 1 })).toBe(true)
  expect(isOneShot({ prompts: 1, requests: 0 })).toBe(true)
  expect(isOneShot({ prompts: 1, requests: 2 })).toBe(false)
  expect(isOneShot({ prompts: 2, requests: 2 })).toBe(false)
})

describe("time", () => {
  const now = new Date(2026, 10, 23, 15, 0).getTime() // a Monday afternoon, local time
  const at = (d: number, h = 12) => new Date(2026, 10, 23 - d, h).getTime()
  test("stamp is the time of day, except in another year", () => {
    expect(stamp(at(2, 9), now)).toBe("09:00")
    expect(stamp(new Date(2026, 5, 30, 14, 32).getTime(), now)).toBe("14:32")
    expect(stamp(new Date(2025, 5, 30, 14, 32).getTime(), now)).toBe("")
  })
  test("ago is short and the same style throughout", () => {
    expect(ago(now - 10_000, now)).toBe("just now")
    expect(ago(now - 18 * 60_000, now)).toBe("18m")
    expect(ago(now - 3 * 3600_000, now)).toBe("3h")
    expect(ago(at(2), now)).toBe("Sat")
    expect(ago(new Date(2026, 5, 30).getTime(), now)).toBe("Jun 30")
    expect(ago(new Date(2025, 5, 30).getTime(), now)).toBe("Jun 30, 2025")
  })
  test("bucketOf goes by calendar day", () => {
    expect(bucketOf(at(0, 0), now)).toBe("Today")
    expect(bucketOf(at(1, 23), now)).toBe("Yesterday")
    expect(bucketOf(at(1, 0), now)).toBe("Yesterday")
    expect(bucketOf(at(6), now)).toBe("This week")
    expect(bucketOf(at(7), now)).toBe("Earlier")
  })
})
