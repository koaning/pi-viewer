import { createResource, createSignal } from "solid-js"
import type { CatalogModel } from "../api"
import type { ModelCost, ModelRef } from "../messages"
import { priced, type PriceLookup } from "../pricing"

// pi's model catalog, for context windows and prices, fetched once per page. Plus the model whose prices stand in for
// unpriced ones, remembered in this browser.

const [models] = createResource(async (): Promise<readonly CatalogModel[]> => {
  try {
    const res = await fetch("/api/models")
    return res.ok ? await res.json() : []
  } catch {
    return []
  }
})

export const catalog = () => models() ?? []

const index = () => {
  const byKey = new Map<string, CatalogModel>()
  const byId = new Map<string, CatalogModel>()
  for (const m of catalog()) {
    byKey.set(`${m.provider}/${m.id}`, m)
    if (!byId.has(m.id)) byId.set(m.id, m)
  }
  return { byKey, byId }
}
let cached: { list: readonly CatalogModel[]; index: ReturnType<typeof index> } | undefined
const lookupIndex = () => {
  const list = catalog()
  if (cached?.list !== list) cached = { list, index: index() }
  return cached.index
}

/** The catalog's entry for a model, by provider and id, else by id from any provider (for its window). */
export const modelInfo = (ref: { readonly providerID: string; readonly id: string } | undefined, loose = false): CatalogModel | undefined => {
  if (!ref) return undefined
  const { byKey, byId } = lookupIndex()
  return byKey.get(`${ref.providerID}/${ref.id}`) ?? (loose ? byId.get(ref.id) : undefined)
}

export const lookup: PriceLookup = (ref: ModelRef) => modelInfo(ref)?.cost

const KEY = "pi-viewer:fallback"
const read = () => {
  try {
    return localStorage.getItem(KEY) ?? ""
  } catch {
    return ""
  }
}
const [fallbackKey, setFallbackKey] = createSignal(read())

export { fallbackKey }

export const setFallback = (key: string) => {
  setFallbackKey(key)
  try {
    if (key) localStorage.setItem(KEY, key)
    else localStorage.removeItem(KEY)
  } catch {
    // Private mode: it lasts for this page.
  }
}

export const fallbackModel = () => (fallbackKey() ? lookupIndex().byKey.get(fallbackKey()) : undefined)
export const fallbackCost = (): readonly ModelCost[] | undefined => fallbackModel()?.cost

/** Models with a price, to stand in for the rest. */
export const pricedModels = () => catalog().filter((m) => priced(m.cost))
