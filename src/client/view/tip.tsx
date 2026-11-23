import { createSignal, Show, type JSX } from "solid-js"

/**
 * One floating tooltip for a dashboard: charts call `show` on pointer move with what to say, and `hide` on leave.
 * Positioned against the dashboard root, clamped inside it.
 */
export function createTip() {
  const [tip, setTip] = createSignal<{ x: number; y: number; content: JSX.Element }>()
  let root: HTMLElement | undefined

  const show = (event: PointerEvent | MouseEvent, content: JSX.Element) => {
    if (!root) return
    const box = root.getBoundingClientRect()
    setTip({ x: event.clientX - box.left + root.scrollLeft, y: event.clientY - box.top + root.scrollTop, content })
  }
  const hide = () => setTip(undefined)

  const View = () => (
    <Show when={tip()}>
      {(t) => (
        <div
          class="ocv-tip"
          role="tooltip"
          style={{
            left: `${Math.min(t().x + 12, (root?.clientWidth ?? 400) - 220)}px`,
            top: `${t().y + 14}px`,
          }}
        >
          {t().content}
        </div>
      )}
    </Show>
  )

  return { show, hide, View, ref: (el: HTMLElement) => (root = el) }
}

export type Tip = ReturnType<typeof createTip>
