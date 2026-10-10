import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions, Timer } from 'claude-code'

import type { ActionButton, PaneRecord, Panel, View } from '../types'
import {
  PANE_PREFIX,
  MAX_ID,
  MAX_VIEW_CHARS,
  RESERVED_IDS,
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

/**
 * Characters of Svg source one pane draws in all; the single constant C1's probe
 * tunes. Probe 2026-10-10: ~260k characters of Svg in one desktop pane drew fine.
 */
export const SVG_PAGE_BUDGET = 240_000
/** One Svg over 131,072 characters is refused and takes the pane down with it; probe-measured cap below that. */
const SVG_ELEMENT_MAX = 120_000
/** Pixels per terminal column when a pane's width is turned into an Svg width (probe: ~8). */
const PX_PER_COLUMN = 8
/** `$.fs.read` refuses a larger file, so a bigger one is too large before it is read. */
const SVG_FILE_MAX_BYTES = 4 * 1024 * 1024

const TOOL = 'mcp__canvas__show'
const DEFAULT_COMMANDS_FILE = '~/.config/canvas/commands.json'
const PRESS_TIMEOUT_MS = 120_000
const REFRESH_TIMEOUT_MS = 60_000

const paneIds = atom({ plugin: 'canvas', key: 'paneIds' } as const, [] as string[])
const panes = { plugin: 'canvas', key: 'panes' } as const

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
          set: { type: 'string', description: 'media: absolute path of a *.curate.json set (arrives with curate).' },
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

const short = (label: string): string => (label.length > 40 ? `${label.slice(0, 39)}…` : label)

// ---- state -----------------------------------------------------------------

async function getRecord($: Dollar, id: string): Promise<PaneRecord | null> {
  return (await read($, { ...panes, id })) ?? null
}

/** Drops a pane's record, id and timer. Idempotent: a person's close and /canvas close can both land. */
async function forget($: Dollar, id: string): Promise<void> {
  disarm(id)
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
    await $.command.register({
      name: 'canvas',
      description: 'List the canvas panes, or close one',
      argumentHint: '[close <id>]',
    })
  } catch {
    $.ui.log('canvas: the /canvas command could not be registered', { to: 'debug' })
  }
  // A reload dropped every timer of the old environment: the panes kept in $.state arm again.
  for (const record of await openRecords($)) arm($, config, record.view)
}

/** Hooks the pane tool, its command and its drawing. */
export function registerCanvas(on: On, options: PluginOptions): void {
  const file = options.commandsFile
  config = { commandsFile: typeof file === 'string' && file.trim() !== '' ? file.trim() : DEFAULT_COMMANDS_FILE }
  const cfg = config

  // The probe hooks session.start unmatched and a module may do that once, so this
  // matcher names every session: interactive or not.
  on('session.start', { isInteractive: [true, false] }, async ($, e, next) => {
    await startCanvas($)
    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const parsed = parseShow(e)
    if (!parsed.ok) return { deny: `canvas show: ${parsed.error}` }
    const { view, notes } = parsed.value

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
      if (RESERVED_IDS.includes(id)) return next(e) // the render probe draws this one
      return <Box><Text dimColor>This pane has no content any more. Close it with /canvas close {id}.</Text></Box>
    }

    const { view } = record
    const needsAllowlist = view.refresh !== undefined || view.panels.some(p => p.kind === 'actions' && p.buttons.some(b => b.run !== undefined))
    const allowed: Allowlist = needsAllowlist ? await loadAllowlist($, cfg) : new Map()
    const paneWidth = Math.max(1, e.props.bodyColumns) * PX_PER_COLUMN

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
        case 'media':
          body.push(<Text dimColor>media panel: arrives with curate (vault-2lzfb)</Text>)
          break
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
