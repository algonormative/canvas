// The canvas mod's contract: the shapes it keeps in $.state and the input of
// its one model tool. Imported by the hooks modules; declares nothing on $.

export type ProbePage = 'image' | 'size' | 'interactive'

/** One tile of a stats panel. */
export type StatItem = { label: string; value: string }

/** One button of an actions panel: exactly one of `run` (a command NAME from the allowlist) or `prompt`. */
export type ActionButton = { label: string; run?: string; prompt?: string }

export type Panel =
  | { kind: 'markdown'; text: string }
  | { kind: 'stats'; items: StatItem[] }
  | { kind: 'table'; columns: string[]; rows: string[][] }
  | { kind: 'svg'; source?: string; path?: string; alt: string }
  | { kind: 'media'; set: string }
  | { kind: 'actions'; buttons: ActionButton[] }

/** `run` is a command name; its stdout must be a JSON array of `{ index, panel }` patches. */
export type Refresh = { everySeconds: number; run: string }

/** A declarative pane, as `mcp__canvas__show` stores it (validated and cleaned). */
export type View = { id: string; title: string; panels: Panel[]; refresh?: Refresh }

/**
 * What a pane keeps in $.state. `refreshFailed` is true from a failed refresh
 * until the next good one; `revision` counts the `show` calls that wrote the
 * view, so a refresh that finishes after a newer `show` drops its patches.
 */
export type PaneRecord = { view: View; refreshFailed: boolean; revision: number }

/** The model-facing input of `show`; the hook validates it again, since the model can send anything. */
export type ShowInput = {
  id: string
  title?: string
  panels: unknown[]
  refresh?: { everySeconds: number; run: string }
}

declare module 'claude-code' {
  interface PluginState {
    canvas: {
      probePage: ProbePage
      probeSize: number
      /** One member per open `show` pane, keyed by its id; `null` once the pane is gone. */
      panes: StateFamily<PaneRecord | null>
      /** Ids of the open `show` panes, oldest first: the index the family cannot give. */
      paneIds: string[]
    }
  }

  interface McpToolInputs {
    mcp__canvas__show: ShowInput
  }
}
