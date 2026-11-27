// highlight.js with the languages coding agents mostly touch. Loaded on first use, as its own chunk.
import hljs from "highlight.js/lib/core"
import bash from "highlight.js/lib/languages/bash"
import css from "highlight.js/lib/languages/css"
import diff from "highlight.js/lib/languages/diff"
import go from "highlight.js/lib/languages/go"
import ini from "highlight.js/lib/languages/ini"
import javascript from "highlight.js/lib/languages/javascript"
import json from "highlight.js/lib/languages/json"
import markdown from "highlight.js/lib/languages/markdown"
import python from "highlight.js/lib/languages/python"
import rust from "highlight.js/lib/languages/rust"
import sql from "highlight.js/lib/languages/sql"
import typescript from "highlight.js/lib/languages/typescript"
import xml from "highlight.js/lib/languages/xml"
import yaml from "highlight.js/lib/languages/yaml"

const languages = { bash, css, diff, go, ini, javascript, json, markdown, python, rust, sql, typescript, xml, yaml }
for (const [name, language] of Object.entries(languages)) hljs.registerLanguage(name, language)

/** What auto-detection picks among, for code with no file name: the languages a snippet usually is. */
const GUESSES = ["python", "typescript", "javascript", "bash", "sql", "json"]

/** Highlighted HTML (highlight.js escapes the text), or undefined when the language is unknown or a guess is weak. */
export const highlight = (code: string, language: string | undefined): string | undefined => {
  if (language) return hljs.getLanguage(language) ? hljs.highlight(code, { language, ignoreIllegals: true }).value : undefined
  const guess = hljs.highlightAuto(code, GUESSES)
  // Short or plain text scores low; leave it plain rather than colour it wrong.
  return guess.relevance >= 8 ? guess.value : undefined
}
