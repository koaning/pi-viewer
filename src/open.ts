import { spawn } from "node:child_process"

/** Opens a URL in the default browser, quietly doing nothing where there isn't one. */
export const open = (url: string) => {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]]
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => undefined).unref()
  } catch {
    // No browser to open.
  }
}
