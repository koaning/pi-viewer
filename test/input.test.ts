import { describe, expect, test } from "bun:test"
import { inputFields, shellLines, shellTokens } from "../src/client/view/input"

const example =
  'cd /x/assets && grep -o "static async create({widgetDef:t,onDestr.\\{0,200\\}" index.js | head -1; echo ---; grep -o "import([^)]\\{0,60\\})" index.js | sort -u | head'

describe("shellLines", () => {
  test("puts each step on its own line, keeping pipes and quoted text whole", () => {
    expect(shellLines(example)).toBe(
      [
        "cd /x/assets &&",
        'grep -o "static async create({widgetDef:t,onDestr.\\{0,200\\}" index.js | head -1;',
        "echo ---;",
        'grep -o "import([^)]\\{0,60\\})" index.js | sort -u | head',
      ].join("\n"),
    )
  })

  test("leaves alone what it can't safely split", () => {
    expect(shellLines("a\nb && c")).toBe("a\nb && c")
    expect(shellLines("cat <<EOF && x")).toBe("cat <<EOF && x")
    expect(shellLines("find . -exec rm {} \\; && ls")).toBe("find . -exec rm {} \\; &&\nls")
    expect(shellLines("echo 'a; b' && (cd x; ls)")).toBe("echo 'a; b' &&\n(cd x; ls)")
    expect(shellLines("cmd 2>&1 | tail")).toBe("cmd 2>&1 | tail")
  })
})

describe("shellTokens", () => {
  const kinds = (command: string) => shellTokens(command).filter((t) => t.kind !== "text").map((t) => `${t.kind}:${t.text}`)

  test("keeps the text exactly", () => {
    expect(shellTokens(example).map((t) => t.text).join("")).toBe(example)
  })

  test("finds programs, flags, strings, variables and operators", () => {
    expect(kinds('FOO=1 grep -o "a b" $HOME/x | head -1 && echo ${X}; ls')).toEqual([
      "cmd:grep",
      "flag:-o",
      'string:"a b"',
      "var:$HOME",
      "op:|",
      "cmd:head",
      "flag:-1",
      "op:&&",
      "cmd:echo",
      "var:${X}",
      "op:;",
      "cmd:ls",
    ])
    expect(kinds("cmd 2>&1 > out.txt # done")).toEqual(["cmd:cmd", "op:2>&1", "op:>", "comment:# done"])
  })
})

describe("inputFields", () => {
  test("shows the main argument first, strings as they are, short values inline", () => {
    expect(inputFields("bash", { timeout: 10, command: "a && b" })).toMatchObject([
      { key: "command", text: "a &&\nb", block: true },
      { key: "timeout", text: "10", block: false },
    ])
    expect(inputFields("edit", { path: "x.ts", oldText: "a\nb", newText: "c" })).toMatchObject([
      { key: "path", text: "x.ts", block: false },
      { key: "oldText", text: "a\nb", block: true },
      { key: "newText", text: "c", block: false },
    ])
  })
})
