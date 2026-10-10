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

// ---- media curation ------------------------------------------------------------

export type MediaMode = 'pick-one' | 'pick-many' | 'triage' | 'rate'
export type Verdict = 'keep' | 'toss' | 'maybe' | 'pick'

/** One item of a set file as the mod keeps it. `where` is the absolute path, or the URL of a link item. */
export type SetItem = {
  id: string
  where: string
  isUrl: boolean
  label: string
  verdict: Verdict | null
  rating: number | null
}

/** A set file's content, reduced to what the panel draws (notes and other fields stay in the file). */
export type SetData = {
  title: string
  mode: MediaMode
  items: SetItem[]
  done: boolean
  /** True once the set carries a `handoff` stamp: Claude has been told. */
  isHandedOff: boolean
}

/**
 * An open set. `path` is the canonical (realpath) set file; the verdicts come from reading
 * the file, never from a press, so a redraw shows what is on disk.
 */
export type SetRecord = {
  path: string
  data: SetData
  /** The file's mtime when `data` was read: a render that finds another one reloads. */
  mtimeMs: number
  /** True while the file on disk no longer parses and `data` is the last good copy. */
  isStale: boolean
  cursor: number
  isFocus: boolean
  /** Id of the item whose clip plays, or null. */
  playing: string | null
  /** What previews taught about an item (its kind, its clip), for `p`, keyed by item id. `o` never trusts it. */
  learned: Record<string, { kind: string; clip: string | null }>
  /**
   * Set once the result went to Claude but writing the hand-off stamp into the file failed: while it is
   * there the result is not sent again, and the stamp is retried (`retries` made so far, the digest of
   * the summary that was sent). Absent or null otherwise (state from an older load has no field).
   */
  stampPending?: StampPending | null
}

export type StampPending = { via: 'submit' | 'fill'; digest: string; retries: number }

/** What `canvas-preview --json` said about one file, reduced to what is drawn. */
export type PreviewData = {
  kind: string
  mime: string
  label: string
  /** Numeric and dimension fields only; anything else is dropped on the way in. */
  meta: Record<string, number>
  svg: string | null
  clip: string | null
  markdown: string | null
  tier: 'rich' | 'reduced' | 'card'
  reason: string | null
}

/**
 * `preview` is null when canvas-preview could not be run or answered nonsense; such an entry carries `at`
 * (the clock when it was stored) and is tried again after 30 s.
 */
export type PreviewEntry = { preview: PreviewData | null; at?: number }

/** A hand-off that could not reach the prompt box and rides the next prompt as context. */
export type PendingHandoff = { set: string; text: string }

/** The model-facing input of `curate`: a set file, or the items to make one from. */
export type CurateInput = {
  set?: string
  items?: string[]
  title?: string
  mode?: MediaMode
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
      /** One member per open set, keyed by a short key of its canonical path; `null` once closed. */
      sets: StateFamily<SetRecord | null>
      /** Keys of the open curate panes, oldest first. */
      curateKeys: string[]
      /** Preview results keyed `<set key>|<item id>|<budget>|<mtime:size of the file>`; `null` once evicted. */
      previews: StateFamily<PreviewEntry | null>
      /** Preview keys with their weight in characters, oldest first: what evicts the oldest. */
      previewIndex: { id: string; size: number }[]
      /** Hand-offs waiting for the next prompt to ride along. */
      pending: PendingHandoff[]
    }
  }

  interface McpToolInputs {
    mcp__canvas__show: ShowInput
    mcp__canvas__curate: CurateInput
  }
}
