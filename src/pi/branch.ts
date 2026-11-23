import type { PiEntry } from "./types"

export interface Branch {
  /** The entries from the root to the leaf, in order. */
  readonly entries: readonly PiEntry[]
  /** Other leaves in the tree: branches left behind with /tree, /fork-in-place and the like. */
  readonly abandoned: number
}

/**
 * The active branch of a session tree. pi appends every entry as a child of the current position, so the last entry
 * in the file is the leaf, and its ancestors (by `parentId`) are what the conversation consists of now. Moving in
 * the tree without writing anything isn't on disk, so the dashboard follows the last write.
 */
export const activeBranch = (entries: readonly PiEntry[]): Branch => {
  const withIds = entries.filter((e) => typeof e.id === "string")
  // Version 1 files have no tree: the whole file is the conversation.
  if (withIds.length === 0 || withIds.every((e) => e.parentId === undefined)) return { entries, abandoned: 0 }
  const byId = new Map(withIds.map((e) => [e.id, e]))
  const path: PiEntry[] = []
  const seen = new Set<string>()
  let at: PiEntry | undefined = withIds[withIds.length - 1]
  while (at && !seen.has(at.id)) {
    seen.add(at.id)
    path.push(at)
    at = at.parentId ? byId.get(at.parentId) : undefined
  }
  path.reverse()

  const parents = new Set(withIds.map((e) => e.parentId).filter((id): id is string => !!id))
  // Leaves that hold conversation, not bookkeeping (labels and names hang off whatever was current).
  const leaves = withIds.filter((e) => !parents.has(e.id) && e.type === "message" && !seen.has(e.id))
  return { entries: path, abandoned: leaves.length }
}
