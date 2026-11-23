import type { CostBreakdown, ModelCost, ModelRef } from "./messages"
import type { Usage } from "./model"

/**
 * Where a cost figure comes from.
 * - `reported`: what pi recorded for the request (the provider's figure, or its tokens at pi's catalog rates).
 * - `estimated`: tokens × the model's catalog price, because pi recorded $0 (subscriptions, plans, local models).
 * - `fallback`: tokens × the price of the model the user chose for unpriced models.
 * - `none`: nothing to price it with (local models with no fallback set).
 */
export type CostKind = "reported" | "estimated" | "fallback" | "none"

/** A cost in USD by what it paid for. `output` includes reasoning, which is billed as output. */
export interface CostSplit {
  readonly cacheRead: number
  readonly input: number
  readonly cacheWrite: number
  readonly output: number
}

export const SPLIT_KEYS = ["cacheRead", "input", "cacheWrite", "output"] as const

export interface Cost {
  readonly value: number
  readonly kind: CostKind
  /** Some of the requests summed into it had no price, so the value leaves them out. */
  readonly partial?: boolean
  /** What the value paid for, when there are rates to tell; adds up to `value`. */
  readonly split?: CostSplit
}

export const NO_COST: Cost = { value: 0, kind: "none" }

/** Looks up a model's catalog price; undefined when the catalog doesn't list it. */
export type PriceLookup = (model: ModelRef) => readonly ModelCost[] | undefined

/** A price list with at least one non-zero rate. Free-tier entries price everything at $0, which says nothing. */
export const priced = (costs: readonly ModelCost[] | undefined): costs is readonly ModelCost[] =>
  !!costs?.some((c) => c.input > 0 || c.output > 0 || c.cache.read > 0 || c.cache.write > 0)

/**
 * The entry that applies at a context size: the largest context tier the request reached, else the base entry
 * (the one without a tier).
 */
export const tierFor = (costs: readonly ModelCost[], context: number): ModelCost | undefined => {
  const base = costs.find((c) => !c.tier) ?? costs[0]
  let best: ModelCost | undefined
  for (const c of costs) {
    if (!c.tier || c.tier.size > context) continue
    if (!best?.tier || c.tier.size > best.tier.size) best = c
  }
  return best ?? base
}

const ZERO_SPLIT: CostSplit = { cacheRead: 0, input: 0, cacheWrite: 0, output: 0 }

export const splitTotal = (s: CostSplit) => s.cacheRead + s.input + s.cacheWrite + s.output

/** USD for one request's tokens, by kind. Reasoning is billed as output. Rates are per million tokens. */
export const splitPrice = (usage: Usage, costs: readonly ModelCost[], context: number): CostSplit => {
  const rate = tierFor(costs, context)
  if (!rate) return ZERO_SPLIT
  return {
    cacheRead: (usage.cacheRead * rate.cache.read) / 1_000_000,
    input: (usage.input * rate.input) / 1_000_000,
    cacheWrite: (usage.cacheWrite * rate.cache.write) / 1_000_000,
    output: ((usage.output + usage.reasoning) * rate.output) / 1_000_000,
  }
}

/** USD for one request's tokens. */
export const price = (usage: Usage, costs: readonly ModelCost[], context: number): number =>
  splitTotal(splitPrice(usage, costs, context))

const scaleSplit = (s: CostSplit, k: number): CostSplit => ({
  cacheRead: s.cacheRead * k,
  input: s.input * k,
  cacheWrite: s.cacheWrite * k,
  output: s.output * k,
})

const addSplit = (a: CostSplit, b: CostSplit): CostSplit => ({
  cacheRead: a.cacheRead + b.cacheRead,
  input: a.input + b.input,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  output: a.output + b.output,
})

/**
 * The cost of one request: what was reported, else an estimate from the catalog, else from the fallback model. A
 * reported cost is split by kind at the rates there are, scaled to add up to what was reported.
 */
export const costOf = (input: {
  readonly reported: number | undefined
  /** What the reported cost paid for, when the source splits it. */
  readonly reportedSplit?: CostBreakdown
  readonly usage: Usage
  readonly context: number
  readonly model: ModelRef | undefined
  readonly lookup: PriceLookup
  readonly fallback: readonly ModelCost[] | undefined
}): Cost => {
  const own = input.model && input.lookup(input.model)
  const rates = priced(own) ? own : priced(input.fallback) ? input.fallback : undefined
  const split = rates && splitPrice(input.usage, rates, input.context)
  if (input.reported && input.reported > 0) {
    const given = input.reportedSplit
    if (given) {
      const own: CostSplit = { cacheRead: given.cacheRead, input: given.input, cacheWrite: given.cacheWrite, output: given.output }
      const sum = splitTotal(own)
      if (sum > 0) return { value: input.reported, kind: "reported", split: scaleSplit(own, input.reported / sum) }
    }
    const sum = split ? splitTotal(split) : 0
    return { value: input.reported, kind: "reported", split: split && sum > 0 ? scaleSplit(split, input.reported / sum) : undefined }
  }
  if (!split) return NO_COST
  return { value: splitTotal(split), kind: rates === own ? "estimated" : "fallback", split }
}

const rank: Record<CostKind, number> = { reported: 0, estimated: 1, fallback: 2, none: 3 }

/**
 * Adds costs. The sum is as uncertain as its least certain priced part; unpriced parts add nothing but mark the sum
 * `partial`.
 */
export const addCost = (a: Cost, b: Cost): Cost => {
  if (a.kind === "none" && b.kind === "none") return NO_COST
  if (a.kind === "none" || b.kind === "none") {
    const known = a.kind === "none" ? b : a
    return { ...known, partial: true }
  }
  return {
    value: a.value + b.value,
    kind: rank[a.kind] >= rank[b.kind] ? a.kind : b.kind,
    partial: a.partial || b.partial || undefined,
    split: a.split && b.split ? addSplit(a.split, b.split) : undefined,
  }
}

/** The sum of many costs, as `addCost` adds two; nothing to add is `NO_COST`. */
export const sumCosts = (costs: Iterable<Cost>): Cost => {
  let total: Cost | undefined
  for (const cost of costs) total = total ? addCost(total, cost) : cost
  return total ?? NO_COST
}
