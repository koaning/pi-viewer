import { homedir } from "node:os"
import { join, resolve } from "node:path"

const expand = (path: string) => (path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path)

/** pi's agent directory: `$PI_CODING_AGENT_DIR`, else `~/.pi/agent`. */
export const agentDir = (env: NodeJS.ProcessEnv = process.env) => resolve(expand(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")))

/** Where pi keeps sessions: `$PI_CODING_AGENT_SESSION_DIR`, else `sessions/` in the agent directory. */
export const sessionsDir = (env: NodeJS.ProcessEnv = process.env) =>
  resolve(expand(env.PI_CODING_AGENT_SESSION_DIR || join(agentDir(env), "sessions")))
