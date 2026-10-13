import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions, Timer } from 'claude-code'

import type { ActionButton, PaneRecord, PendingHandoff, Panel, View } from '../types'
import { cli, clearPlaying, closeSet, openSetFile, putSet, resumeStamps, setKeyOf, stopSet, watchSet } from './curate'
import type { Host } from './curate'
import { PX_PER_COLUMN, SVG_ELEMENT_MAX, SVG_PAGE_BUDGET } from './layout'
import { renderMediaPanel } from './media'
import type { Kit } from './media'
import { MAX_PATH, inlineSetName, keyOf, parseCurate } from './setmodel'
import {
  PANE_PREFIX,
  MAX_ID,
  MAX_VIEW_CHARS,
  applyPatches,
  cleanText,
  looksLikeSvg,
  parseCommands,
  parsePatches,
  parseShow,
  runNames,
} from './view'
import type { CommandEntry } from './view'

// The `show` tool: the model sends a declarative view, the mod keeps it in
// $.state under the pane's id and draws it. All media work belongs to the CLI;
// nothing here calls a model, and a command only ever runs by NAME through the
// allowlist file, whose contents the model can neither read nor change.

export { SVG_PAGE_BUDGET } from './layout'
/** `$.fs.read` refuses a larger file, so a bigger one is too large before it is read. */
const SVG_FILE_MAX_BYTES = 4 * 1024 * 1024

const TOOL = 'mcp__canvas__show'
const CURATE_TOOL = 'mcp__canvas__curate'
/** A curate pane's id is this plus the set's key. */
const CURATE_PREFIX = 'curate-'
const DEFAULT_COMMANDS_FILE = '~/.config/canvas/commands.json'
const PRESS_TIMEOUT_MS = 120_000
const REFRESH_TIMEOUT_MS = 60_000

const paneIds = atom({ plugin: 'canvas', key: 'paneIds' } as const, [] as string[])
const panes = { plugin: 'canvas', key: 'panes' } as const
// Media curation: one record per open set, one entry per preview, and the hand-offs waiting for a prompt.
const sets = { plugin: 'canvas', key: 'sets' } as const
const curateKeys = atom({ plugin: 'canvas', key: 'curateKeys' } as const, [] as string[])
const previews = { plugin: 'canvas', key: 'previews' } as const
const previewIndex = atom({ plugin: 'canvas', key: 'previewIndex' } as const, [] as { id: string; size: number }[])
const pending = atom({ plugin: 'canvas', key: 'pending' } as const, [] as PendingHandoff[])

// Module variables hold only what dies with the module anyway: timers and
// in-flight guards. A hot reload drops them; session.start re-arms from $.state.
const timers = new Map<string, Timer>()
const refreshing = new Set<string>()
const pressing = new Set<string>()

type Config = { commandsFile: string }
type Allowlist = Map<string, CommandEntry>
type Dollar = EngineInterface

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    id: {
      type: 'string',
      pattern: '^[A-Za-z0-9_-]+$',
      maxLength: MAX_ID,
      description: 'Pane id: letters, digits, "_" and "-". Calling show again with the same id updates that pane in place; a new id opens another pane.',
    },
    title: { type: 'string', description: "The pane's tab title; defaults to the id." },
    panels: {
      type: 'array',
      minItems: 1,
      maxItems: 40,
      description: 'Stacked top to bottom. Each panel has a "kind" and that kind\'s fields.',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['markdown', 'stats', 'table', 'svg', 'media', 'actions'] },
          text: { type: 'string', description: 'markdown: the text.' },
          items: {
            type: 'array',
            description: 'stats: tiles.',
            items: {
              type: 'object',
              properties: { label: { type: 'string' }, value: { type: 'string' } },
              required: ['label', 'value'],
            },
          },
          columns: { type: 'array', items: { type: 'string' }, description: 'table: header cells.' },
          rows: {
            type: 'array',
            items: { type: 'array', items: { type: 'string' } },
            description: 'table: one array of cells per row, as many cells as columns.',
          },
          source: { type: 'string', description: 'svg: the <svg> markup (give source or path, not both).' },
          path: { type: 'string', description: 'svg: absolute path of an .svg file, read each time the pane draws.' },
          alt: { type: 'string', description: 'svg: what the picture shows; this is all a terminal draws.' },
          set: { type: 'string', description: 'media: absolute path of a *.curate.json set; the panel curates it in place (keys j k y n m 1-5 p o f d).' },
          buttons: {
            type: 'array',
            description: 'actions: buttons. Give each exactly one of run or prompt.',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                run: { type: 'string', description: 'A command NAME from the allowlist file, never a command line.' },
                prompt: { type: 'string', description: "Text added to the user's draft box; they review and send it." },
              },
              required: ['label'],
            },
          },
        },
        required: ['kind'],
      },
    },
    refresh: {
      type: 'object',
      description: 'Re-run an allowlisted command on a timer and patch the panels from its output.',
      properties: {
        everySeconds: { type: 'number', minimum: 5, description: 'Seconds between runs (at least 5).' },
        run: {
          type: 'string',
          description: 'A command NAME from the allowlist. It must print a JSON array of {"index": n, "panel": {...}} on stdout; each replaces panels[n].',
        },
      },
      required: ['everySeconds', 'run'],
    },
  },
  required: ['id', 'panels'],
}

const DESCRIPTION =
  'Show or update a pane beside the conversation that the user can read and click. Panels: markdown, stats tiles, a table, an SVG picture, ' +
  'a media set, and action buttons. The same id again replaces that pane in place; the result says whether it is drawn and does not echo the view. ' +
  'Buttons run a command only by NAME through the user\'s allowlist (an unknown name draws as a disabled "not allowed" button; you cannot add to the list), ' +
  'or put text in the user\'s draft box with "prompt" - nothing is sent for them. "refresh" re-runs an allowlisted command every few seconds and patches ' +
  "panels from the JSON it prints. The user closes a pane with /canvas close <id>."

const CURATE_SCHEMA = {
  type: 'object',
  properties: {
    set: {
      type: 'string',
      maxLength: MAX_PATH,
      description: 'Absolute path of an existing *.curate.json set file (made with canvas-set new). Give this or items, not both.',
    },
    items: {
      type: 'array',
      minItems: 1,
      maxItems: 500,
      items: { type: 'string', maxLength: MAX_PATH },
      description: 'Absolute paths of the files to curate (or http(s) URLs, which show as link cards). A set file is written under ~/.cache/canvas/sets for them.',
    },
    title: { type: 'string', maxLength: 100, description: 'items: the set\'s title. Default "Curate".' },
    mode: {
      type: 'string',
      enum: ['pick-one', 'pick-many', 'triage', 'rate'],
      description: 'items: how the user decides. pick-one (one winner, sent as soon as they pick), pick-many, triage (keep / maybe / toss; the default), rate (1-5). Everything but pick-one is sent when they press Done.',
    },
  },
}

const CURATE_DESCRIPTION =
  'Open a set of media (audio, images, video, SVG, PDFs, text) in a pane for the user to curate: each item has a preview that fits the pane, ' +
  'and they keep, toss, maybe, pick or rate them with keys or buttons. Give "set" (an existing *.curate.json) or "items" with "title" and "mode". ' +
  'Returns at once with the number of items and does not echo them; the result arrives later as a prompt from the user when they finish ' +
  '(for pick-one, the moment they pick; otherwise when they press Done). Do not wait or poll, and do not call it again for a set that is already open: it only refocuses the pane.'

const short = (label: string): string => (label.length > 40 ? `${label.slice(0, 39)}…` : label)

// ---- state -----------------------------------------------------------------

async function getRecord($: Dollar, id: string): Promise<PaneRecord | null> {
  return (await read($, { ...panes, id })) ?? null
}

/** Drops a pane's record, id and timer. Idempotent: a person's close and /canvas close can both land. */
async function forget($: Dollar, id: string): Promise<void> {
  disarm(id)
  // A clip a media panel of this pane is playing stops with the pane.
  for (const panel of (await getRecord($, id))?.view.panels ?? []) if (panel.kind === 'media') stopSet(await setKeyOf(mediaHost($), panel.set))
  await update($, paneIds, ids => ids.filter(one => one !== id))
  await update($, { ...panes, id }, () => null)
}

/** The records of panes the engine still has open; records of closed ones are dropped on the way. */
async function openRecords($: Dollar): Promise<PaneRecord[]> {
  let live: Set<string> | undefined
  try {
    live = new Set((await $.ui.panes()).map(pane => pane.id))
  } catch {
    live = undefined // the engine's list is unavailable: keep what we hold
  }
  const out: PaneRecord[] = []
  for (const id of await read($, paneIds)) {
    const record = await getRecord($, id)
    if (!record || (live && !live.has(PANE_PREFIX + id))) {
      await forget($, id)
      continue
    }
    out.push(record)
  }
  return out
}

// ---- the allowlist -----------------------------------------------------------

async function expandHome($: Dollar, path: string): Promise<string> {
  if (path !== '~' && !path.startsWith('~/')) return path
  const home = await $.env.get('HOME')
  return home ? home.replace(/\/$/, '') + path.slice(1) : path
}

/** Missing, unreadable or malformed file: nothing is allowed. The mod never creates it. */
async function loadAllowlist($: Dollar, cfg: Config): Promise<Allowlist> {
  try {
    const body = await $.fs.read(await expandHome($, cfg.commandsFile))
    return parseCommands(typeof body === 'string' ? body : '')
  } catch {
    return new Map()
  }
}

async function runInit($: Dollar, entry: CommandEntry, timeoutMs: number) {
  return entry.cwd === undefined
    ? { timeoutMs }
    : { cwd: await expandHome($, entry.cwd), timeoutMs }
}

// ---- refresh -----------------------------------------------------------------

function disarm(id: string): void {
  try {
    timers.get(id)?.cancel()
  } catch {
    // a timer of a dropped environment: nothing left to cancel
  }
  timers.delete(id)
}

function arm($: Dollar, cfg: Config, view: View): void {
  disarm(view.id)
  if (!view.refresh) return
  timers.set(view.id, $.clock.every(view.refresh.everySeconds * 1000, () => {
    void refreshOnce($, cfg, view.id).catch(() => undefined)
  }))
}

/** One tick: run the command, patch the panels, or keep the last ones and say so. */
async function refreshOnce($: Dollar, cfg: Config, id: string): Promise<void> {
  if (refreshing.has(id)) return // the last run is still going: skip this tick
  refreshing.add(id)
  try {
    const before = await getRecord($, id)
    if (!before) {
      disarm(id)
      return
    }
    const refresh = before.view.refresh
    if (!refresh) return

    let patched: View | undefined
    const entry = (await loadAllowlist($, cfg)).get(refresh.run)
    if (entry) {
      try {
        const out = await $.process.run(entry.argv, await runInit($, entry, REFRESH_TIMEOUT_MS))
        const parsed = out.exitCode === 0 ? parsePatches(out.stdout, before.view.panels.length) : undefined
        if (parsed?.ok) {
          const view = applyPatches(before.view, parsed.value)
          if (JSON.stringify(view.panels).length <= MAX_VIEW_CHARS) patched = view
        }
      } catch {
        patched = undefined
      }
    }

    const next: PaneRecord = patched
      ? { ...before, view: patched, refreshFailed: false }
      : { ...before, refreshFailed: true }
    if (JSON.stringify(next) === JSON.stringify(before)) return // nothing new: no redraw
    // A newer `show` may have replaced the view while the command ran: then these patches are stale.
    await update($, { ...panes, id }, cur => (cur && cur.revision === before.revision ? next : cur ?? null))
  } finally {
    refreshing.delete(id)
  }
}

// ---- button presses ------------------------------------------------------------

async function pressRun($: Dollar, cfg: Config, paneId: string, button: ActionButton): Promise<void> {
  const label = short(button.label)
  const name = button.run ?? ''
  const entry = (await loadAllowlist($, cfg)).get(name)
  if (!entry) {
    $.ui.toast(`${label}: not allowed`)
    return
  }
  const lock = `${paneId}:${name}`
  if (pressing.has(lock)) {
    $.ui.toast(`${label}: still running`)
    return
  }
  pressing.add(lock)
  try {
    const out = await $.process.run(entry.argv, await runInit($, entry, PRESS_TIMEOUT_MS))
    // The outcome is a toast only: output never goes back to the model.
    $.ui.toast(out.exitCode === 0 ? `${label}: done` : `${label}: failed (exit ${out.exitCode})`)
  } catch {
    $.ui.toast(`${label}: failed (could not run)`)
  } finally {
    pressing.delete(lock)
  }
}

/** A prompt button drafts; the person sends. Never `$.prompt.submit`. */
async function pressPrompt($: Dollar, button: ActionButton): Promise<void> {
  const filled = await $.prompt.fill({ text: button.prompt ?? '', mode: 'append' })
  if (!filled.isFilled) $.ui.toast(`${short(button.label)}: could not add to your draft`)
}

// ---- drawing -------------------------------------------------------------------

function tableMarkdown(panel: Extract<Panel, { kind: 'table' }>): string {
  const cell = (s: string) => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|')
  const row = (cells: readonly string[]) => `| ${cells.map(cell).join(' | ')} |`
  return [row(panel.columns), row(panel.columns.map(() => '---')), ...panel.rows.map(row)].join('\n')
}

type SvgSource = { source: string } | { problem: 'unreadable' | 'too-large' }

async function loadSvg($: Dollar, panel: Extract<Panel, { kind: 'svg' }>): Promise<SvgSource> {
  if (panel.source !== undefined) return { source: panel.source }
  const path = panel.path ?? ''
  try {
    if ((await $.fs.stat(path)).size > SVG_FILE_MAX_BYTES) return { problem: 'too-large' }
    const body = await $.fs.read(path)
    const source = typeof body === 'string' ? cleanText(body) : ''
    return looksLikeSvg(source) ? { source } : { problem: 'unreadable' }
  } catch {
    return { problem: 'unreadable' }
  }
}

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

// ---- media curation -----------------------------------------------------------------

/**
 * What the curate code (curate.ts, media.tsx) may do, as closures over this file's `$`: the
 * engine follows `$` only inside the file whose hook holds it, so the code that needs it takes this.
 */
function mediaHost($: Dollar): Host {
  return {
    getSet: async key => (await read($, { ...sets, id: key })) ?? null,
    updateSet: async (key, fn) => {
      await update($, { ...sets, id: key }, cur => fn(cur ?? null))
    },
    getPreview: async id => (await read($, { ...previews, id })) ?? null,
    setPreview: async (id, entry) => {
      await update($, { ...previews, id }, () => entry)
    },
    updatePreviewIndex: async fn => {
      await update($, previewIndex, fn)
    },
    updatePending: async fn => {
      await update($, pending, fn)
    },
    home: async () => (await $.env.get('HOME')) || undefined,
    run: async (argv, timeoutMs) => {
      const out = await $.process.run(argv, { timeoutMs })
      return { exitCode: out.exitCode, stdout: out.stdout, stderr: out.stderr }
    },
    stat: async path => {
      const found = await $.fs.stat(path, { resolve: true })
      return { mtimeMs: found.mtimeMs, size: found.size, kind: found.kind, realPath: found.realPath }
    },
    now: async () => await $.clock.now(),
    readText: async path => {
      const body = await $.fs.read(path)
      return typeof body === 'string' ? body : ''
    },
    readBase64: async path => (await $.fs.read(path, { as: 'bytes' })).base64,
    play: (base64, signal) => $.audio.play({ base64, mime: 'audio/mpeg' }, { signal }),
    later: (ms, fn) => {
      $.clock.after(ms, fn)
    },
    toast: text => $.ui.toast(text),
    debug: text => $.ui.log(`canvas: ${text}`, { to: 'debug' }),
    promptText: async () => (await $.prompt.read()).text,
    submit: async text => {
      // A prompt another plugin dropped never reached the model: that is a failure, not a send.
      const sent = await $.prompt.submit({ text })
      if (sent.drop !== undefined) throw new Error(sent.drop)
    },
    fill: async text => (await $.prompt.fill({ text, mode: 'append' })).isFilled,
  }
}

const oneLineError = (text: string): string => cleanText(text.split('\n').find(line => line.trim() !== '') ?? 'failed').slice(0, 300)

/** The `curate` tool: take (or write) the set, open its pane, and return at once. */
async function curateCall($: Dollar, input: unknown): Promise<{ result: string } | { deny: string }> {
  const parsed = parseCurate(input)
  if (!parsed.ok) return { deny: `canvas curate: ${parsed.error}` }
  const host = mediaHost($)
  const request = parsed.value

  let setPath: string
  let isNew = false
  if (request.kind === 'set') {
    setPath = request.set
  } else {
    const home = await host.home()
    if (!home) return { deny: 'canvas curate: HOME is not set, so there is nowhere to write the set file' }
    setPath = `${home.replace(/\/$/, '')}/.cache/canvas/sets/${inlineSetName(request.title, await $.clock.now())}`
    try {
      // `--title=` keeps a title that starts with a dash from being read as an option; `--` does the same for the items.
      // `--literal`: the items are the model's, so each is one file as given, never a glob to expand.
      const made = await cli(host, 'canvas-set', ['new', '--literal', `--title=${request.title}`, `--mode=${request.mode}`, '-o', setPath, '--', ...request.items])
      if (made.exitCode !== 0) return { deny: `canvas curate: ${oneLineError(made.stderr)}` }
    } catch {
      return { deny: 'canvas curate: canvas-set could not be run (is it on the PATH?)' }
    }
    isNew = true
  }

  const opened = await openSetFile(host, setPath)
  if (!opened.ok) return { deny: `canvas curate: ${opened.error}` }
  const { title, items } = opened.record.data
  const key = keyOf(opened.record.path)
  const paneId = CURATE_PREFIX + key
  let isOpen = false
  try {
    isOpen = (await read($, curateKeys)).includes(key) && (await $.ui.panes()).some(pane => pane.id === paneId)
  } catch {
    isOpen = false
  }

  await putSet(host, key, opened.record)
  await update($, curateKeys, keys => (keys.includes(key) ? keys : [...keys, key]))

  let drawn = ''
  try {
    // focus: a pane opened without it never gets the hotkeys.
    const placed = await $.ui.open({ id: paneId, title, focus: true })
    if (!placed.isPlaced) drawn = ` The pane is not drawn yet (${placed.reason}).`
  } catch {
    if (!isOpen) await update($, curateKeys, keys => keys.filter(one => one !== key))
    return { deny: 'canvas curate: the pane could not be opened' }
  }
  watchSet(host, key)
  const count = `${items.length} ${items.length === 1 ? 'item' : 'items'}`
  const head = isOpen
    ? `Focused ${title} (${count}), already open in a pane`
    : `Opened ${title} (${count}) in a pane`
  const where = isNew ? ` Set file: ${opened.record.path}.` : ''
  return { result: `${head}; the result arrives as a later prompt when the user finishes.${where}${drawn}` }
}

// ---- hooks ---------------------------------------------------------------------

// Written by registerCanvas: the options are fixed for one load of the module.
let config: Config = { commandsFile: DEFAULT_COMMANDS_FILE }

async function startCanvas($: Dollar): Promise<void> {
  for (const id of [...timers.keys()]) disarm(id)
  try {
    await $.tool.register({ name: 'show', description: DESCRIPTION, inputSchema: INPUT_SCHEMA })
  } catch {
    $.ui.log('canvas: the show tool could not be registered', { to: 'debug' })
  }
  try {
    await $.tool.register({ name: 'curate', description: CURATE_DESCRIPTION, inputSchema: CURATE_SCHEMA })
  } catch {
    $.ui.log('canvas: the curate tool could not be registered', { to: 'debug' })
  }
  try {
    await $.command.register({
      name: 'canvas',
      description: 'List the canvas panes, or close one',
      argumentHint: '[close <id>]',
    })
  } catch {
    $.ui.log('canvas: the /canvas command could not be registered', { to: 'debug' })
  }
  // A reload dropped every timer of the old environment: the panes kept in $.state arm again.
  const records = await openRecords($)
  for (const record of records) arm($, config, record.view)
  // ... and the clip that was playing, so no set is left saying it still is.
  const host = mediaHost($)
  const mediaKeys: string[] = []
  for (const { view } of records) for (const panel of view.panels) if (panel.kind === 'media') mediaKeys.push(await setKeyOf(host, panel.set))
  const setKeys = [...(await read($, curateKeys)), ...mediaKeys]
  await clearPlaying(host, setKeys)
  // ... and the polling of each open curate set's file.
  for (const key of await read($, curateKeys)) watchSet(host, key)
  // ... and the retries of a hand-off stamp that could not be written, which died with the timers.
  await resumeStamps(host, setKeys)
}

/** Hooks the pane tool, its command and its drawing. */
export function registerCanvas(on: On, options: PluginOptions): void {
  const file = options.commandsFile
  config = { commandsFile: typeof file === 'string' && file.trim() !== '' ? file.trim() : DEFAULT_COMMANDS_FILE }
  const cfg = config

  // Every session, interactive or not.
  on('session.start', { isInteractive: [true, false] }, async ($, e, next) => {
    await startCanvas($)
    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const parsed = parseShow(e)
    if (!parsed.ok) return { deny: `canvas show: ${parsed.error}` }
    const { view, notes } = parsed.value

    // A media panel's set is opened (validated, read) now, so the pane draws it at once.
    const host = mediaHost($)
    for (const [i, panel] of view.panels.entries()) {
      if (panel.kind !== 'media') continue
      const opened = await openSetFile(host, panel.set)
      // Keyed on the real path (as curate keys it), so a link to a set and the set are one set.
      if (opened.ok) await putSet(host, keyOf(opened.record.path), opened.record)
      else notes.push(`panels[${i}]: the set could not be opened (${opened.error}).`)
    }

    const existed = (await read($, paneIds)).includes(view.id)
    const before = existed ? await getRecord($, view.id) : null
    const record: PaneRecord = { view, refreshFailed: false, revision: (before?.revision ?? 0) + 1 }
    await update($, { ...panes, id: view.id }, () => record)
    await update($, paneIds, ids => (ids.includes(view.id) ? ids : [...ids, view.id]))
    arm($, cfg, view)

    let drawn: string
    try {
      const opened = await $.ui.open({ id: PANE_PREFIX + view.id, title: view.title })
      drawn = opened.isPlaced ? 'drawn' : `not drawn yet (${opened.reason})`
    } catch {
      if (!existed) await forget($, view.id)
      return { deny: 'canvas show: the pane could not be opened' }
    }

    const allowed = await loadAllowlist($, cfg)
    const blocked = runNames(view).filter(name => !allowed.has(name))
    const lines = [`Pane "${view.id}" ${existed ? 'updated in place' : 'created'}; ${drawn}.`, ...notes]
    if (blocked.length > 0) {
      lines.push(`Not in the command allowlist, so those buttons draw as "not allowed" and a refresh will not run: ${blocked.join(', ')}.`)
    }
    return { result: lines.join(' ') }
  }).catch(() => ({ deny: 'canvas show: failed unexpectedly, try again' }))

  on('command.run', { command: 'canvas' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    if (verb === '' || verb === 'list') return { text: await listText($) }
    if (verb === 'close' && rest.length === 1) return { text: await closeText($, rest[0] ?? '') }
    return { text: 'Usage: /canvas to list the panes, /canvas close <id> to close one.' }
  }).catch(() => ({ text: 'canvas: that failed, try again.' }))

  on('tool.call', { tool: CURATE_TOOL }, async ($, e) => curateCall($, e)).catch(() => ({
    deny: 'canvas curate: failed unexpectedly, try again',
  }))

  // A result that could not be put in the draft box rides the next prompt the person sends.
  on('prompt.submit', async ($, e, next) => {
    const waiting = await read($, pending)
    if (waiting.length === 0) return next(e)
    const context = waiting.map(one => `Result of the curation pane (it could not be put in the prompt box when the user finished, so it rides this prompt):\n${one.text}`)
    const out = await next({ ...e, context: [...(e.context ?? []), ...context] })
    if (out.drop === undefined) {
      await update($, pending, list => list.filter(one => !waiting.some(w => w.set === one.set && w.text === one.text)))
    }
    return out
  }).catch(($, e, next) => next(e))

  on('ui.close', { id: /^curate-/ }, async ($, e, next) => {
    const out = await next(e)
    if (!('deny' in out) || out.deny === undefined) {
      const key = e.id.slice(CURATE_PREFIX.length)
      await closeSet(mediaHost($), key)
      await update($, curateKeys, keys => keys.filter(one => one !== key))
    }
    return out
  })

  on('ui.render', { component: 'Pane', requestId: /^curate-/ }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = els
    const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : undefined
    const kit: Kit = Svg ? { Box, Text, Button, Markdown, Svg } : { Box, Text, Button, Markdown }
    const media = await renderMediaPanel(mediaHost($), kit, {
      key: e.requestId.slice(CURATE_PREFIX.length),
      index: 0,
      hotkeys: true,
      columns: Math.max(1, e.props.bodyColumns),
      pageBudget: SVG_PAGE_BUDGET,
    })
    return media.tree
  })

  // A close by the person's mark or key reaches here too; an unload does not (its state stays for the reload).
  on('ui.close', { id: /^canvas-/ }, async ($, e, next) => {
    const out = await next(e)
    if (!('deny' in out) || out.deny === undefined) await forget($, e.id.slice(PANE_PREFIX.length))
    return out
  })

  on('ui.render', { component: 'Pane', requestId: /^canvas-/ }, async ($, e, next) => {
    const id = e.requestId.slice(PANE_PREFIX.length)
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = els
    // The terminal draws no pictures. The kit's table lists Svg on every surface, so the surface is asked first.
    const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : undefined
    const record = await getRecord($, id) // reading while drawing subscribes the pane to its record
    if (!record) {
      return <Box><Text dimColor>This pane has no content any more. Close it with /canvas close {id}.</Text></Box>
    }

    const { view } = record
    const needsAllowlist = view.refresh !== undefined || view.panels.some(p => p.kind === 'actions' && p.buttons.some(b => b.run !== undefined))
    const allowed: Allowlist = needsAllowlist ? await loadAllowlist($, cfg) : new Map()
    const paneWidth = Math.max(1, e.props.bodyColumns) * PX_PER_COLUMN

    const kit: Kit = Svg ? { Box, Text, Button, Markdown, Svg } : { Box, Text, Button, Markdown }
    const firstMedia = view.panels.findIndex(p => p.kind === 'media')
    // A media panel's pictures arrive one by one, so its share of the page is reserved up front (equal
    // shares, one more for the plain Svg panels if there are any): the budget it asks previews for then
    // never changes as they load, and a sibling's previews never cost this panel a refetch.
    const mediaCount = view.panels.filter(p => p.kind === 'media').length
    const mediaShare = Math.floor(SVG_PAGE_BUDGET / Math.max(1, mediaCount + (view.panels.some(p => p.kind === 'svg') ? 1 : 0)))
    let svgUsed = 0
    const body: JSX.Element[] = []
    for (const [i, panel] of view.panels.entries()) {
      switch (panel.kind) {
        case 'markdown':
          body.push(<Markdown text={panel.text} />)
          break
        case 'stats':
          body.push(
            <Box flexDirection="row" flexWrap="wrap" columnGap={3}>
              {panel.items.map(item => (
                <Box flexDirection="column">
                  <Text dimColor>{item.label}</Text>
                  <Text bold>{item.value}</Text>
                </Box>
              ))}
            </Box>,
          )
          break
        case 'table':
          body.push(<Markdown text={tableMarkdown(panel)} />)
          break
        case 'svg': {
          if (!Svg) {
            body.push(<Text>{panel.alt}</Text>) // a terminal draws no pictures: the alt stands in
            break
          }
          const svg = await loadSvg($, panel)
          if ('problem' in svg) {
            const why = svg.problem === 'too-large' ? 'too large to draw' : `could not read ${baseName(panel.path ?? '')}`
            body.push(<Text dimColor>{panel.alt} - {why}</Text>)
          } else if (svg.source.length > Math.min(SVG_PAGE_BUDGET - svgUsed, SVG_ELEMENT_MAX)) {
            body.push(<Text dimColor>{panel.alt} - too large to draw</Text>)
          } else {
            svgUsed += svg.source.length
            const natural = naturalWidth(svg.source)
            // A picture wider than the pane is clipped, so it is sized to the pane instead.
            body.push(
              natural !== undefined && natural > paneWidth
                ? <Svg source={svg.source} alt={panel.alt} width={paneWidth} />
                : <Svg source={svg.source} alt={panel.alt} />,
            )
          }
          break
        }
        case 'media': {
          const pageBudget = Math.min(mediaShare, Math.max(0, SVG_PAGE_BUDGET - svgUsed))
          const media = await renderMediaPanel(mediaHost($), kit, {
            key: await setKeyOf(mediaHost($), panel.set),
            index: i,
            hotkeys: i === firstMedia,
            columns: Math.max(1, e.props.bodyColumns),
            pageBudget,
            reopen: panel.set,
          })
          svgUsed += pageBudget
          body.push(media.tree)
          break
        }
        case 'actions':
          body.push(
            <Box flexDirection="row" flexWrap="wrap" gap={1}>
              {panel.buttons.map((button, j) => {
                const key = `a${i}-${j}`
                if (button.prompt !== undefined) {
                  return <Button key={key} label={button.label} onPress={() => void pressPrompt($, button)} />
                }
                const name = button.run ?? ''
                if (!allowed.has(name)) {
                  // No `disabled` prop exists: a dim button whose press only explains.
                  return (
                    <Button
                      key={key}
                      label={`not allowed: ${name}`}
                      dimColor
                      onPress={() => $.ui.toast(`${short(button.label)}: ${name} is not in the command allowlist`)}
                    />
                  )
                }
                return <Button key={key} label={button.label} onPress={() => void pressRun($, cfg, view.id, button)} />
              })}
            </Box>,
          )
          break
      }
    }

    const refresh = view.refresh
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>{view.title}</Text>
        {body}
        {refresh && !allowed.has(refresh.run) && <Text dimColor>refresh not allowed: {refresh.run}</Text>}
        {refresh && allowed.has(refresh.run) && record.refreshFailed && <Text dimColor>refresh failed: {refresh.run}</Text>}
      </Box>
    )
  })

}

/** The root element's width in pixels, from `width` or else the viewBox; undefined when it says neither. */
function naturalWidth(source: string): number | undefined {
  const tag = /<svg\b[^>]*>/.exec(source.slice(0, 4000))?.[0] ?? ''
  const width = /\swidth\s*=\s*["']\s*([0-9.]+)\s*(?:px)?\s*["']/.exec(tag)?.[1]
  if (width !== undefined && Number(width) > 0) return Number(width)
  const box = /\sviewBox\s*=\s*["']\s*[-0-9.]+[\s,]+[-0-9.]+[\s,]+([0-9.]+)[\s,]+[0-9.]+\s*["']/.exec(tag)?.[1]
  return box !== undefined && Number(box) > 0 ? Number(box) : undefined
}

async function listText($: Dollar): Promise<string> {
  const records = await openRecords($)
  if (records.length === 0) return 'No canvas panes are open.'
  const lines = records.map(({ view }) => {
    const title = view.title === view.id ? '' : ` - ${view.title}`
    const every = view.refresh ? ` (refreshes every ${view.refresh.everySeconds} s)` : ''
    return `- ${view.id}${title}${every}`
  })
  return [`Canvas panes (${records.length}):`, ...lines, 'Close one with /canvas close <id>.'].join('\n')
}

async function closeText($: Dollar, id: string): Promise<string> {
  const open = (await openRecords($)).map(r => r.view.id)
  if (!open.includes(id)) {
    return open.length === 0
      ? `No canvas pane "${id}": none are open.`
      : `No canvas pane "${id}". Open: ${open.join(', ')}.`
  }
  await forget($, id)
  await $.ui.close({ id: PANE_PREFIX + id })
  return `Closed "${id}".`
}
