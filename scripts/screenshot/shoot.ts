import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { writeDemo, writeOthers } from "./demo"

// Serves the made-up sessions in demo.ts with the built CLI and saves light and dark screenshots of the session list
// and of one session to docs/.
// Run `bun run build` first.

const root = fileURLToPath(new URL("../../", import.meta.url))
const out = (name: string) => join(root, "docs", name)
const dir = mkdtempSync(join(tmpdir(), "pi-viewer-shots-"))
const main = writeDemo(dir)
// The main session ended 40 minutes ago, as far as the list is concerned.
utimesSync(main, new Date(Date.now() - 40 * 60_000), new Date(Date.now() - 40 * 60_000))
writeOthers(dir)

const port = 4580 + Math.floor(Math.random() * 100)
const server = spawn("node", [join(root, "dist", "cli.js"), "--dir", dir, "--port", String(port), "--no-open"], { stdio: "ignore" })
await new Promise((done) => setTimeout(done, 1200))

const browser = await chromium.launch()
try {
  for (const mode of ["light", "dark"] as const) {
    const page = await browser.newPage({ viewport: { width: 640, height: 900 }, deviceScaleFactor: 2, reducedMotion: "reduce", colorScheme: mode })
    page.on("pageerror", (error) => console.error(error))
    await page.goto(`http://localhost:${port}/#/s/01a2demo-0000-7000-8000-000000000001`)
    await page.waitForSelector(".ocv-strip")
    await page.waitForTimeout(600)
    await page.screenshot({ path: out(`screenshot-${mode}.png`), fullPage: true })
    console.log(`wrote docs/screenshot-${mode}.png`)
    await page.goto(`http://localhost:${port}/#/`)
    await page.waitForSelector(".pv-card")
    await page.waitForTimeout(400)
    await page.screenshot({ path: out(`home-${mode}.png`), fullPage: true })
    console.log(`wrote docs/home-${mode}.png`)
    await page.close()
  }
} finally {
  await browser.close()
  server.kill()
  rmSync(dir, { recursive: true, force: true })
}
