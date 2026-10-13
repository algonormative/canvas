import type { ActionButton, Panel, Refresh, View } from '../types'

// Pure parts of the `show` tool: validating what the model sends, what a refresh
// command prints, and the command allowlist file. Nothing here touches `$`, so
// the error text it returns is exactly what the model reads back.

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

/** The command allowlist: name -> argv (+ cwd). Owned by the user, never written by the mod. */
export type CommandEntry = { argv: string[]; cwd?: string }

export type Patch = { index: number; panel: Panel }

export const PANE_PREFIX = 'canvas-'
// A pane id is 1-64 of letters, digits, `_`, `-`; ours carries the prefix.
export const MAX_ID = 64 - PANE_PREFIX.length
export const MIN_REFRESH_SECONDS = 5
export const MAX_REFRESH_SECONDS = 86_400

const ID_RE = /^[A-Za-z0-9_-]+$/
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
// Every C0/C1 control character and DEL except tab and newline, which text may keep.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g

const MAX_PANELS = 40
const MAX_TITLE = 100
const MAX_TEXT = 60_000
const MAX_CELL = 500
const MAX_LABEL = 100
const MAX_ITEMS = 30
const MAX_COLUMNS = 12
const MAX_ROWS = 500
const MAX_BUTTONS = 12
const MAX_PROMPT = 4_000
const MAX_SVG_SOURCE = 1_000_000
const MAX_PATCHES = 40
const MAX_ARGV = 64
/** What one stored view may weigh as JSON: $.state holds it for the pane's life. */
export const MAX_VIEW_CHARS = 2_000_000

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error })

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Text keeps tabs and newlines; every other control character goes. */
export function cleanText(v: string): string {
  return v.replace(CONTROL_RE, '')
}

/** One line: control characters out, tabs and newlines to spaces. */
function oneLine(v: string): string {
  return cleanText(v).replace(/[\t\n]+/g, ' ').trim()
}

type Limits = { max: number; required?: boolean }

/** Whether `source` opens like an SVG document (an XML prolog and comments may come first). */
export function looksLikeSvg(source: string): boolean {
  return /^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/.test(source.slice(0, 2000))
}

function lineField(v: unknown, path: string, { max, required = true }: Limits): Result<string> {
  if (typeof v !== 'string') return fail(`${path}: expected a string`)
  const out = oneLine(v)
  if (required && out === '') return fail(`${path}: must not be empty`)
  if (out.length > max) return fail(`${path}: ${out.length} characters, the limit is ${max}`)
  return { ok: true, value: out }
}

function textField(v: unknown, path: string, max: number): Result<string> {
  if (typeof v !== 'string') return fail(`${path}: expected a string`)
  const out = cleanText(v)
  if (out.trim() === '') return fail(`${path}: must not be empty`)
  if (out.length > max) return fail(`${path}: ${out.length} characters, the limit is ${max}`)
  return { ok: true, value: out }
}

export function isCommandName(name: unknown): name is string {
  return typeof name === 'string' && NAME_RE.test(name)
}

function nameField(v: unknown, path: string): Result<string> {
  if (!isCommandName(v)) {
    return fail(`${path}: expected a command name (letters, digits, . _ -; up to 64), got ${JSON.stringify(String(v)).slice(0, 80)}`)
  }
  return { ok: true, value: v }
}

function listField(v: unknown, path: string, max: number): Result<unknown[]> {
  if (!Array.isArray(v)) return fail(`${path}: expected an array`)
  if (v.length === 0) return fail(`${path}: must not be empty`)
  if (v.length > max) return fail(`${path}: ${v.length} entries, the limit is ${max}`)
  return { ok: true, value: v }
}

function parseButton(v: unknown, path: string): Result<ActionButton> {
  if (!isObject(v)) return fail(`${path}: expected an object { label, run | prompt }`)
  const label = lineField(v.label, `${path}.label`, { max: MAX_LABEL })
  if (!label.ok) return label
  const hasRun = v.run !== undefined && v.run !== null
  const hasPrompt = v.prompt !== undefined && v.prompt !== null
  if (hasRun === hasPrompt) return fail(`${path}: give exactly one of "run" (a command name) or "prompt"`)
  if (hasRun) {
    const run = nameField(v.run, `${path}.run`)
    return run.ok ? { ok: true, value: { label: label.value, run: run.value } } : run
  }
  const prompt = textField(v.prompt, `${path}.prompt`, MAX_PROMPT)
  return prompt.ok ? { ok: true, value: { label: label.value, prompt: prompt.value } } : prompt
}

/** Cells may arrive as numbers or booleans; they are shown as text. */
function cell(v: unknown, path: string): Result<string> {
  if (typeof v === 'number' || typeof v === 'boolean') return { ok: true, value: String(v) }
  if (v === null) return { ok: true, value: '' }
  if (typeof v !== 'string') return fail(`${path}: expected text`)
  const out = oneLine(v)
  if (out.length > MAX_CELL) return fail(`${path}: ${out.length} characters, the limit is ${MAX_CELL}`)
  return { ok: true, value: out }
}

export function parsePanel(v: unknown, path: string): Result<Panel> {
  if (!isObject(v)) return fail(`${path}: expected an object with a "kind"`)
  switch (v.kind) {
    case 'markdown': {
      const body = textField(v.text, `${path}.text`, MAX_TEXT)
      return body.ok ? { ok: true, value: { kind: 'markdown', text: body.value } } : body
    }
    case 'stats': {
      const list = listField(v.items, `${path}.items`, MAX_ITEMS)
      if (!list.ok) return list
      const items = []
      for (const [i, raw] of list.value.entries()) {
        if (!isObject(raw)) return fail(`${path}.items[${i}]: expected { label, value }`)
        const label = lineField(raw.label, `${path}.items[${i}].label`, { max: MAX_LABEL })
        if (!label.ok) return label
        const value = cell(raw.value, `${path}.items[${i}].value`)
        if (!value.ok) return value
        items.push({ label: label.value, value: value.value })
      }
      return { ok: true, value: { kind: 'stats', items } }
    }
    case 'table': {
      const cols = listField(v.columns, `${path}.columns`, MAX_COLUMNS)
      if (!cols.ok) return cols
      const columns: string[] = []
      for (const [i, raw] of cols.value.entries()) {
        const c = lineField(raw, `${path}.columns[${i}]`, { max: MAX_LABEL, required: false })
        if (!c.ok) return c
        columns.push(c.value)
      }
      // A table with no rows is a valid thing to show ("nothing yet").
      if (!Array.isArray(v.rows)) return fail(`${path}.rows: expected an array of rows`)
      if (v.rows.length > MAX_ROWS) return fail(`${path}.rows: ${v.rows.length} rows, the limit is ${MAX_ROWS}`)
      const rows: string[][] = []
      for (const [r, raw] of v.rows.entries()) {
        if (!Array.isArray(raw)) return fail(`${path}.rows[${r}]: expected an array of cells`)
        if (raw.length !== columns.length) {
          return fail(`${path}.rows[${r}]: ${raw.length} cells for ${columns.length} columns`)
        }
        const cells: string[] = []
        for (const [c, one] of raw.entries()) {
          const parsed = cell(one, `${path}.rows[${r}][${c}]`)
          if (!parsed.ok) return parsed
          cells.push(parsed.value)
        }
        rows.push(cells)
      }
      return { ok: true, value: { kind: 'table', columns, rows } }
    }
    case 'svg': {
      const alt = lineField(v.alt, `${path}.alt`, { max: MAX_CELL })
      if (!alt.ok) return alt
      const hasSource = v.source !== undefined && v.source !== null
      const hasPath = v.path !== undefined && v.path !== null
      if (hasSource === hasPath) return fail(`${path}: give exactly one of "source" (the <svg> markup) or "path" (an absolute file path)`)
      if (hasSource) {
        const source = textField(v.source, `${path}.source`, MAX_SVG_SOURCE)
        if (!source.ok) return source
        if (!looksLikeSvg(source.value)) return fail(`${path}.source: expected an <svg ...> document`)
        return { ok: true, value: { kind: 'svg', source: source.value, alt: alt.value } }
      }
      const file = lineField(v.path, `${path}.path`, { max: 1000 })
      if (!file.ok) return file
      if (!file.value.startsWith('/')) return fail(`${path}.path: must be an absolute path`)
      return { ok: true, value: { kind: 'svg', path: file.value, alt: alt.value } }
    }
    case 'media': {
      const set = lineField(v.set, `${path}.set`, { max: 1000 })
      if (!set.ok) return set
      if (!set.value.startsWith('/')) return fail(`${path}.set: must be an absolute path to a *.curate.json file`)
      return { ok: true, value: { kind: 'media', set: set.value } }
    }
    case 'actions': {
      const list = listField(v.buttons, `${path}.buttons`, MAX_BUTTONS)
      if (!list.ok) return list
      const buttons: ActionButton[] = []
      for (const [i, raw] of list.value.entries()) {
        const b = parseButton(raw, `${path}.buttons[${i}]`)
        if (!b.ok) return b
        buttons.push(b.value)
      }
      return { ok: true, value: { kind: 'actions', buttons } }
    }
    default:
      return fail(`${path}.kind: expected markdown, stats, table, svg, media or actions, got ${JSON.stringify(String(v.kind)).slice(0, 60)}`)
  }
}

export type ParsedShow = { view: View; notes: string[] }

/** Validates a `show` call into a clean View; the error is written for the model. */
export function parseShow(input: unknown): Result<ParsedShow> {
  if (!isObject(input)) return fail('expected an object { id, title?, panels, refresh? }')
  const notes: string[] = []

  if (typeof input.id !== 'string' || !ID_RE.test(input.id) || input.id.length > MAX_ID) {
    return fail(`id: expected 1-${MAX_ID} letters, digits, "_" or "-"`)
  }
  const id = input.id

  let title = id
  if (input.title !== undefined && input.title !== null) {
    const t = lineField(input.title, 'title', { max: MAX_TITLE })
    if (!t.ok) return t
    title = t.value
  }

  const list = listField(input.panels, 'panels', MAX_PANELS)
  if (!list.ok) return list
  const panels: Panel[] = []
  for (const [i, raw] of list.value.entries()) {
    const p = parsePanel(raw, `panels[${i}]`)
    if (!p.ok) return p
    panels.push(p.value)
  }

  const view: View = { id, title, panels }
  const weight = JSON.stringify(panels).length
  if (weight > MAX_VIEW_CHARS) return fail(`panels: ${weight} characters in all, the limit is ${MAX_VIEW_CHARS}`)
  if (input.refresh !== undefined && input.refresh !== null) {
    if (!isObject(input.refresh)) return fail('refresh: expected { everySeconds, run }')
    const every = input.refresh.everySeconds
    if (typeof every !== 'number' || !Number.isFinite(every) || every <= 0) {
      return fail('refresh.everySeconds: expected a positive number')
    }
    const run = nameField(input.refresh.run, 'refresh.run')
    if (!run.ok) return run
    const everySeconds = Math.min(MAX_REFRESH_SECONDS, Math.max(MIN_REFRESH_SECONDS, Math.round(every)))
    if (everySeconds !== every) notes.push(`refresh.everySeconds was set to ${everySeconds} (allowed ${MIN_REFRESH_SECONDS}-${MAX_REFRESH_SECONDS}).`)
    const refresh: Refresh = { everySeconds, run: run.value }
    view.refresh = refresh
  }
  return { ok: true, value: { view, notes } }
}

/** Every command name a view's buttons and refresh refer to, once each. */
export function runNames(view: View): string[] {
  const names = new Set<string>()
  for (const panel of view.panels) {
    if (panel.kind !== 'actions') continue
    for (const b of panel.buttons) if (b.run !== undefined) names.add(b.run)
  }
  if (view.refresh) names.add(view.refresh.run)
  return [...names]
}

/** A refresh command's stdout: a JSON array of `{ index, panel }`; any fault rejects the whole batch. */
export function parsePatches(stdout: string, panelCount: number): Result<Patch[]> {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return fail('stdout is not JSON')
  }
  if (!Array.isArray(raw)) return fail('stdout is not an array')
  if (raw.length > MAX_PATCHES) return fail('too many patches')
  const patches: Patch[] = []
  for (const [i, one] of raw.entries()) {
    if (!isObject(one) || !Number.isInteger(one.index)) return fail(`patch ${i} has no integer index`)
    const index = one.index as number
    if (index < 0 || index >= panelCount) return fail(`patch ${i} index is out of range`)
    const panel = parsePanel(one.panel, `patch ${i}`)
    if (!panel.ok) return panel
    patches.push({ index, panel: panel.value })
  }
  return { ok: true, value: patches }
}

export function applyPatches(view: View, patches: readonly Patch[]): View {
  const panels = view.panels.slice()
  for (const { index, panel } of patches) panels[index] = panel
  return { ...view, panels }
}

/**
 * The allowlist file: `{ "<name>": { "argv": [...], "cwd"?: "..." } }`. Anything
 * unreadable is an empty list; an entry that is not well formed is left out, so
 * its name shows as not allowed.
 */
export function parseCommands(source: string): Map<string, CommandEntry> {
  const out = new Map<string, CommandEntry>()
  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch {
    return out
  }
  if (!isObject(raw)) return out
  for (const [name, entry] of Object.entries(raw)) {
    if (!isCommandName(name) || !isObject(entry)) continue
    const argv = entry.argv
    if (!Array.isArray(argv) || argv.length === 0 || argv.length > MAX_ARGV) continue
    if (!argv.every(a => typeof a === 'string') || argv[0] === '') continue
    const cwd = entry.cwd
    if (cwd !== undefined && (typeof cwd !== 'string' || cwd === '')) continue
    out.set(name, cwd === undefined ? { argv: argv.slice() } : { argv: argv.slice(), cwd })
  }
  return out
}
