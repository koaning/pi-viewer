import { existsSync, readFileSync, realpathSync } from "node:fs"
import { delimiter, dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import type { CatalogModel } from "../api"
import type { ModelCost } from "../messages"

// pi's model catalog, for context windows and prices: the models built into pi-ai (read from the pi you have
// installed), the ones providers listed at runtime (models-store.json), and your own (models.json). Later ones win.

interface PiCost {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  tiers?: { inputTokensAbove: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number }[]
}

interface PiModel {
  id?: string
  name?: string
  provider?: string
  contextWindow?: number
  cost?: PiCost
}

/** pi's price, with its context tiers, as model.ts prices requests. */
export const costsOf = (cost: PiCost | undefined): ModelCost[] | undefined => {
  if (!cost) return undefined
  const rate = (c: Omit<PiCost, "tiers">) => ({
    input: c.input ?? 0,
    output: c.output ?? 0,
    cache: { read: c.cacheRead ?? 0, write: c.cacheWrite ?? 0 },
  })
  return [
    rate(cost),
    ...(cost.tiers ?? []).map((t) => ({ ...rate({ ...cost, ...t }), tier: { type: "context" as const, size: t.inputTokensAbove } })),
  ]
}

const modelOf = (provider: string, m: PiModel): CatalogModel | undefined =>
  m.id ? { provider: m.provider ?? provider, id: m.id, name: m.name ?? m.id, contextWindow: m.contextWindow, cost: costsOf(m.cost) } : undefined

const readJson = (path: string): any => {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
}

const PACKAGES = ["@earendil-works/pi-ai", "@mariozechner/pi-ai"]
const GENERATED = "dist/models.generated.js"

/** Where the installed pi keeps pi-ai's generated model list. */
export const findGenerated = (agentDir: string, env: NodeJS.ProcessEnv = process.env): string | undefined => {
  const candidates: string[] = []
  try {
    const version = readFileSync(join(agentDir, "install", "current-version"), "utf8").trim()
    for (const pkg of PACKAGES) candidates.push(join(agentDir, "install", "releases", version, "node_modules", pkg, GENERATED))
  } catch {
    // Not installed with pi's installer.
  }
  // Or wherever `pi` on the PATH lives, e.g. a global npm install.
  for (const bin of (env.PATH ?? "").split(delimiter)) {
    const pi = join(bin, "pi")
    if (!existsSync(pi)) continue
    let dir: string
    try {
      dir = dirname(realpathSync(pi))
    } catch {
      continue
    }
    for (let i = 0; i < 8; i++, dir = dirname(dir)) {
      for (const pkg of PACKAGES) {
        candidates.push(join(dir, "node_modules", pkg, GENERATED))
        candidates.push(join(dir, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", pkg, GENERATED))
        candidates.push(join(dir, "node_modules", "@mariozechner", "pi-coding-agent", "node_modules", pkg, GENERATED))
      }
    }
    break
  }
  return candidates.find((path) => existsSync(path))
}

export async function loadCatalog(agentDir: string): Promise<CatalogModel[]> {
  const models = new Map<string, CatalogModel>()
  const put = (m: CatalogModel | undefined) => {
    if (!m) return
    const key = `${m.provider}/${m.id}`
    const before = models.get(key)
    models.set(key, { ...before, ...m, contextWindow: m.contextWindow ?? before?.contextWindow, cost: m.cost ?? before?.cost })
  }

  const generated = findGenerated(agentDir)
  if (generated) {
    try {
      const mod = await import(pathToFileURL(generated).href)
      const all = (mod.MODELS ?? {}) as Record<string, Record<string, PiModel>>
      for (const [provider, list] of Object.entries(all)) for (const m of Object.values(list ?? {})) put(modelOf(provider, m))
    } catch {
      // An older or newer pi with another layout: the other catalogs still help.
    }
  }

  const store = readJson(join(agentDir, "models-store.json"))
  if (store && typeof store === "object")
    for (const [provider, entry] of Object.entries<any>(store))
      for (const m of Array.isArray(entry?.models) ? entry.models : []) put(modelOf(provider, m))

  const custom = readJson(join(agentDir, "models.json"))
  for (const [provider, entry] of Object.entries<any>(custom?.providers ?? {}))
    for (const m of Array.isArray(entry?.models) ? entry.models : []) put(modelOf(provider, m))

  return [...models.values()]
}
