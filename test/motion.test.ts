import { describe, expect, test } from "bun:test"
import { lerpRows, sameRows } from "../src/client/view/motion"

describe("lerpRows", () => {
  test("ends at from and to", () => {
    const from = [[0, 10], [5, 20]]
    const to = [[10, 30], [15, 40]]
    expect(lerpRows(from, to, 0)).toEqual(from)
    expect(lerpRows(from, to, 1)).toEqual(to)
    expect(lerpRows(from, to, 0.5)).toEqual([[5, 20], [10, 30]])
  })

  test("a new row grows out of the last one", () => {
    expect(lerpRows([[0, 10]], [[0, 10], [20, 30]], 0)).toEqual([[0, 10], [0, 10]])
    expect(lerpRows([[0, 10]], [[0, 10], [20, 30]], 0.5)).toEqual([[0, 10], [10, 20]])
  })

  test("starts from zero without rows or columns to start from", () => {
    expect(lerpRows([], [[10, 20]], 0.5)).toEqual([[5, 10]])
    expect(lerpRows([[10]], [[10, 20]], 0.5)).toEqual([[10, 10]])
  })

  test("takes the target's shape when it has fewer rows", () => {
    expect(lerpRows([[0], [1], [2]], [[4]], 1)).toEqual([[4]])
  })
})

describe("sameRows", () => {
  test("compares values, not identity", () => {
    expect(sameRows([[1, 2]], [[1, 2]])).toBe(true)
    expect(sameRows([[1, 2]], [[1, 3]])).toBe(false)
    expect(sameRows([[1, 2]], [[1, 2], [3, 4]])).toBe(false)
    expect(sameRows([[1, 2]], [[1, 2, 3]])).toBe(false)
  })
})
