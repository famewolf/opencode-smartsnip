import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { exec as execCb } from "node:child_process"
import { promisify } from "node:util"
import { loadConfig } from "./config"
import { buildMatchTable } from "./filters"
import { rewrite } from "./router"
import { formatTokens, nowUtcSnipFormat, savingsSince } from "./stats"

// Use opencode's V1 plugin module shape. If the default export is not a
// `{ id, server }` object, opencode falls back to its legacy loader, which walks
// every runtime export and treats each one as a plugin. Keep this entry to a
// single default export; import library helpers from their own modules.

const execAsync = promisify(execCb)

// Single-quote for /bin/sh so the path reaches test/which as one word.
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

const SmartSnipPlugin: Plugin = async ({ client, directory }) => {
  // POSIX parser — PowerShell/native Windows is a non-goal for now
  if (process.platform === "win32") return {}

  const config = loadConfig(directory)
  if (!config.enabled) return {}

  // NOTE (famewolf/opencode-smartsnip#2 + desktop runtime): opencode's $ is
  // Bun.$ — it lacks the `command` builtin (so `command -v` always exited 1
  // under the CLI) and is undefined entirely in the Electron/Node desktop
  // runtime. Probe via node:child_process instead: same behavior on both.
  // Absolute paths get `test -x` (the desktop sidecar may not inherit the
  // shell PATH); bare names fall back to `which`.
  const probe = config.snipPath.includes("/")
    ? `test -x ${shellQuote(config.snipPath)}`
    : `which ${shellQuote(config.snipPath)}`
  try {
    await execAsync(probe)
  } catch {
    console.warn(
      `[smartsnip] '${config.snipPath}' not found — plugin disabled. ` +
        "Install: brew install edouard-claude/tap/snip",
    )
    return {}
  }

  const table = buildMatchTable(config)

  // Savings toast state: report once per session, only counting savings
  // accrued after this plugin instance started.
  const startedAt = nowUtcSnipFormat()
  const toastedSessions = new Set<string>()
  let wrappedAnything = false
  let reportedSavedTokens = 0

  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash") return
      const command = output.args?.command
      if (!command || typeof command !== "string") return
      const rewritten = rewrite(command, table, config)
      if (rewritten !== command) wrappedAnything = true
      output.args.command = rewritten
    },

    event: async ({ event }) => {
      if (!config.toast || event.type !== "session.idle") return
      if (!wrappedAnything) return
      const sessionID = (event as { properties?: { sessionID?: string } }).properties?.sessionID
      if (!sessionID || toastedSessions.has(sessionID)) return

      const savings = savingsSince(startedAt)
      if (!savings || savings.savedTokens <= reportedSavedTokens) return

      toastedSessions.add(sessionID)
      reportedSavedTokens = savings.savedTokens
      try {
        await client.tui.showToast({
          body: {
            title: "smartsnip",
            message: `snip saved ~${formatTokens(savings.savedTokens)} tokens across ${savings.commands} commands`,
            variant: "success",
            duration: 5000,
          },
        })
      } catch {
        // headless / no TUI — stats are a bonus, never a breakage
      }
    },
  }
}

const plugin: PluginModule = {
  id: "opencode-smartsnip",
  server: SmartSnipPlugin,
}

export default plugin
