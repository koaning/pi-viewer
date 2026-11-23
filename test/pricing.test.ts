import { describe, expect, test } from "bun:test"
import type { ModelCost } from "../src/messages"
import { costOf, price, splitPrice, splitTotal, sumCosts, tierFor } from "../src/pricing"
import { ZERO } from "../src/model"

const rate = (input: number, output: number, read = 0, write = 0, tier?: number): ModelCost => ({
  input,
  output,
  cache: { read, write },
  ...(tier ? { tier: { type: "context" as const, size: tier } } : {}),
})

const usage = { ...ZERO, input: 1_000_000, output: 1_000_000, reasoning: 1_000_000, cacheRead: 2_000_000 }

describe("price", () => {
  test("bills reasoning as output and cache reads at their own rate", () => {
    expect(price(usage, [rate(3, 15, 0.3)], 0)).toBeCloseTo(3 + 30 + 0.6)
  })

  test("splits by kind, adding up to the price", () => {
    const usageWithWrite = { ...usage, cacheWrite: 1_000_000 }
    const split = splitPrice(usageWithWrite, [rate(3, 15, 0.3, 3.75)], 0)
    expect(split.cacheRead).toBeCloseTo(0.6)
    expect(split.input).toBeCloseTo(3)
    expect(split.cacheWrite).toBeCloseTo(3.75)
    expect(split.output).toBeCloseTo(30)
    expect(splitTotal(split)).toBeCloseTo(price(usageWithWrite, [rate(3, 15, 0.3, 3.75)], 0))
  })

  test("picks the largest context tier the request reached", () => {
    const tiers = [rate(3, 15), rate(6, 22.5, 0, 0, 200_000), rate(9, 30, 0, 0, 500_000)]
    expect(tierFor(tiers, 100_000)!.input).toBe(3)
    expect(tierFor(tiers, 250_000)!.input).toBe(6)
    expect(tierFor(tiers, 900_000)!.input).toBe(9)
  })
})

describe("costOf", () => {
  const base = { usage, context: 0, model: { id: "m", providerID: "p" } }

  test("prefers the reported cost, split at catalog rates scaled to it", () => {
    const cost = costOf({ ...base, reported: 1.5, lookup: () => [rate(3, 15, 0.3)], fallback: undefined })
    expect(cost).toMatchObject({ value: 1.5, kind: "reported" })
    expect(splitTotal(cost.split!)).toBeCloseTo(1.5)
    // At catalog rates: 0.6 cache reads, 3 input, 30 output, of 33.6.
    expect(cost.split!.output).toBeCloseTo((1.5 * 30) / 33.6)
  })

  test("leaves a reported cost unsplit without rates", () => {
    expect(costOf({ ...base, reported: 1.5, lookup: () => undefined, fallback: undefined })).toEqual({ value: 1.5, kind: "reported", split: undefined })
  })

  test("estimates from the catalog when the provider reports $0", () => {
    expect(costOf({ ...base, reported: 0, lookup: () => [rate(1, 1)], fallback: undefined })).toMatchObject({ value: 3, kind: "estimated", split: { input: 1, output: 2 } })
  })

  test("treats an all-zero price as no price, and uses the fallback", () => {
    expect(costOf({ ...base, reported: 0, lookup: () => [rate(0, 0)], fallback: [rate(2, 2)] })).toMatchObject({ value: 6, kind: "fallback" })
    expect(costOf({ ...base, reported: 0, lookup: () => undefined, fallback: undefined }).kind).toBe("none")
  })
})

test("sumCosts keeps the least certain kind and flags unpriced parts", () => {
  expect(sumCosts([])).toEqual({ value: 0, kind: "none" })
  expect(sumCosts([{ value: 1, kind: "reported" }, { value: 2, kind: "estimated" }])).toEqual({ value: 3, kind: "estimated", partial: undefined, split: undefined })
  expect(sumCosts([{ value: 1, kind: "reported" }, { value: 0, kind: "none" }])).toEqual({ value: 1, kind: "reported", partial: true })
})

test("sumCosts adds splits, and drops them when a part has none", () => {
  const split = (output: number) => ({ cacheRead: 0.5, input: 0, cacheWrite: 0, output })
  const a = { value: 1.5, kind: "reported" as const, split: split(1) }
  const b = { value: 2.5, kind: "reported" as const, split: split(2) }
  expect(sumCosts([a, b]).split).toEqual({ cacheRead: 1, input: 0, cacheWrite: 0, output: 3 })
  expect(sumCosts([a, b, { value: 1, kind: "reported" }]).split).toBeUndefined()
})
