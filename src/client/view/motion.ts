import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js"

export type Rows = readonly (readonly number[])[]

/**
 * Rows of numbers between `from` (t=0) and `to` (t=1). Rows `from` lacks start as its last row (zeros without one), so
 * a new point grows out of the one before it. A row's missing columns start at zero.
 */
export const lerpRows = (from: Rows, to: Rows, t: number): number[][] =>
  to.map((row, i) => {
    const start = from[i] ?? from[from.length - 1] ?? []
    return row.map((value, j) => {
      const a = start[j] ?? 0
      return a + (value - a) * t
    })
  })

export const sameRows = (a: Rows, b: Rows) =>
  a.length === b.length && a.every((row, i) => row.length === b[i]!.length && row.every((v, j) => v === b[i]![j]))

const ease = (t: number) => 1 - (1 - t) ** 3

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches

/**
 * Follows `target` with an eased tween. The first value is taken as is; so is a target with fewer rows than before
 * (a new session, not a step forward) or with rows of another width (a series came or went). Equal targets don't
 * restart the tween, since the dashboard recomputes with the same values every second while a session runs.
 */
export function tweenRows(target: Accessor<Rows>, ms = 400): Accessor<Rows> {
  const [shown, setShown] = createSignal<Rows>(target())
  let goal = target()
  let frame: number | undefined
  const stop = () => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
  }
  createEffect(
    on(
      target,
      (next) => {
        if (sameRows(next, goal)) return
        goal = next
        stop()
        const from = shown()
        const jump = next.length < from.length || from.length === 0 || from[0]!.length !== next[0]?.length
        if (jump || reduced() || typeof requestAnimationFrame !== "function") {
          setShown(next)
          return
        }
        const start = performance.now()
        const tick = (now: number) => {
          const t = Math.min(1, (now - start) / ms)
          setShown(t >= 1 ? next : lerpRows(from, next, ease(t)))
          frame = t < 1 ? requestAnimationFrame(tick) : undefined
        }
        frame = requestAnimationFrame(tick)
      },
      { defer: true },
    ),
  )
  onCleanup(stop)
  return shown
}

/** `tweenRows` for one number. */
export function tween(target: Accessor<number>, ms = 400): Accessor<number> {
  const rows = tweenRows(() => [[target()]], ms)
  return () => rows()[0]?.[0] ?? 0
}
