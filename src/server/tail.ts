import { closeSync, fstatSync, openSync, readSync } from "node:fs"
import type { PiLine } from "../pi/types"

const NEWLINE = 0x0a
const CHUNK = 1 << 20

/**
 * Reads a file that only grows, a complete line at a time. Each `read` returns the lines appended since the last one;
 * a line still being written waits for its newline. A file that shrank or was replaced is read again from the start,
 * and `reset` says so.
 */
export class LineReader {
  private offset = 0
  private rest: Buffer = Buffer.alloc(0)
  private ino: number | bigint | undefined

  constructor(readonly path: string) {}

  read(): { readonly lines: string[]; readonly reset: boolean } {
    let fd: number
    try {
      fd = openSync(this.path, "r")
    } catch {
      return { lines: [], reset: false }
    }
    try {
      const stat = fstatSync(fd)
      let reset = false
      if (stat.size < this.offset || (this.ino !== undefined && stat.ino !== this.ino)) {
        this.offset = 0
        this.rest = Buffer.alloc(0)
        reset = true
      }
      this.ino = stat.ino
      const lines: string[] = []
      while (this.offset < stat.size) {
        const buffer = Buffer.alloc(Math.min(CHUNK, stat.size - this.offset))
        const n = readSync(fd, buffer, 0, buffer.length, this.offset)
        if (n <= 0) break
        this.offset += n
        let data = this.rest.length ? Buffer.concat([this.rest, buffer.subarray(0, n)]) : buffer.subarray(0, n)
        let start = 0
        for (let i = data.indexOf(NEWLINE); i !== -1; i = data.indexOf(NEWLINE, start)) {
          const line = data.subarray(start, i).toString("utf8").trim()
          if (line) lines.push(line)
          start = i + 1
        }
        // Copy what's left, so the chunk it came from can go.
        this.rest = Buffer.from(data.subarray(start))
        data = Buffer.alloc(0)
      }
      return { lines, reset }
    } finally {
      closeSync(fd)
    }
  }

  /** Where the next read starts: the bytes read so far, less a line still being written. */
  get position() {
    return this.offset - this.rest.length
  }
}

/** Images are sent as base64; the dashboard only counts them, so their data stays on the server. */
const stripImages = (content: unknown) => {
  if (!Array.isArray(content)) return content
  return content.map((c) => (c && typeof c === "object" && c.type === "image" ? { type: "image", mimeType: c.mimeType } : c))
}

/** A session file's line, or undefined for one that doesn't parse (a partial write, or not JSON). */
export const parseLine = (line: string): PiLine | undefined => {
  let value: any
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!value || typeof value !== "object" || typeof value.type !== "string") return undefined
  if (value.type === "message" && value.message && typeof value.message === "object") {
    value.message.content = stripImages(value.message.content)
  } else if (value.type === "custom_message") value.content = stripImages(value.content)
  return value as PiLine
}
