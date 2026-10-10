import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RegisteredToolSpec, SessionStartInput } from 'claude-code'

// The `show` tool end to end, on the engine's kit: the tool call, the pane's
// drawing on both surfaces, the command allowlist, refresh and /canvas.
// Nothing here reaches a model, a network or the real allowlist file.

const TOOL = 'mcp__canvas__show'
const HOME = '/home/test'
const COMMANDS = `${HOME}/.config/canvas/commands.json`
const SURFACES = ['terminal', 'desktop'] as const
const START: SessionStartInput = { surface: 'desktop', isInteractive: true, cwd: '/work' }

type Out = { exitCode: number; stdout?: string }
type Exec = (argv: readonly string[]) => Out | Promise<Out>
type Run = { argv: readonly string[]; cwd?: string; timeoutMs?: number }

type World = {
  files: Record<string, string>
  exec: Exec
  placed: boolean
  toasts: string[]
  runs: Run[]
  fills: { text: string; mode?: string }[]
  submits: number
  writes: number
  opens: { id: string; title?: string }[]
  closes: string[]
  open: Set<string>
  tools: RegisteredToolSpec[]
}

// Everything the mod calls on `$`, answered in memory and recorded.
function world(on: On, init: { files?: Record<string, string>; exec?: Exec; placed?: boolean } = {}): World {
  const w: World = {
    files: { ...init.files },
    exec: init.exec ?? (() => ({ exitCode: 0, stdout: '' })),
    placed: init.placed ?? true,
    toasts: [],
    runs: [],
    fills: [],
    submits: 0,
    writes: 0,
    opens: [],
    closes: [],
    open: new Set(),
    tools: [],
  }
  mock.env(on, { HOME })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.register', (_$, e) => {
    w.tools.push(e)
    return { value: { tool: `mcp__canvas__${e.name}` } }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    w.opens.push({ id: e.id, title: e.title })
    w.open.add(e.id)
    return { value: w.placed ? { isPlaced: true as const } : { isPlaced: false as const, reason: 'the terminal is too narrow' } }
  })
  on('ui.close', (_$, e) => {
    w.closes.push(e.id)
    w.open.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: [...w.open].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })),
  }))
  on('fs.read', (_$, e) => {
    if (e.as === 'bytes') return { value: { base64: '' } }
    const body = w.files[e.path]
    return body === undefined ? { deny: 'ENOENT' } : { value: body }
  })
  on('fs.stat', (_$, e) => {
    const body = w.files[e.path]
    return body === undefined
      ? { deny: 'ENOENT' }
      : { value: { kind: 'file' as const, size: body.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.write', () => {
    w.writes += 1
    return { value: undefined }
  })
  on('process.run', async (_$, e) => {
    w.runs.push({ argv: e.argv, cwd: e.init?.cwd, timeoutMs: e.init?.timeoutMs })
    const out = await w.exec(e.argv)
    return { value: { exitCode: out.exitCode, stdout: out.stdout ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('prompt.fill', (_$, e) => {
    w.fills.push({ text: e.text, mode: e.mode })
    return { isFilled: true }
  })
  on('prompt.submit', (_$, e) => {
    w.submits += 1
    return { text: e.text }
  })
  return w
}

const allow = (entries: Record<string, unknown>): Record<string, string> => ({ [COMMANDS]: JSON.stringify(entries) })

const PANE_PROPS = (columns: number) =>
  ({ title: 'x', isFocused: false, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows: 20 } }) as never

async function call($: Engine, input: Record<string, unknown>) {
  const out = await $.tool.call({ tool: TOOL, ...input } as never)
  return 'deny' in out && out.deny !== undefined ? { deny: out.deny } : { text: String((out as { result: unknown }).result) }
}

// A kit instance mounts once per surface and id: drawing again lets the earlier drawing go.
const mounted = new WeakMap<object, Map<string, { unmount: () => Promise<void> }>>()

async function draw($: Engine, surface: (typeof SURFACES)[number], id: string, columns = 100) {
  const mine = mounted.get($) ?? new Map()
  mounted.set($, mine)
  await mine.get(`${surface}:${id}`)?.unmount()
  const ui = await $.ui.mount({ plugin: 'canvas', surface, component: 'Pane', requestId: `canvas-${id}`, props: PANE_PROPS(columns) })
  mine.set(`${surface}:${id}`, ui)
  return ui
}

const SVG = (chars: number, attrs = 'width="100" height="100"'): string => {
  const head = `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>`
  return head + '<!--' + 'x'.repeat(Math.max(0, chars - head.length - 10)) + '-->' + '</svg>'
}

test('show creates a pane, then updates it in place', async ($, on) => {
  const w = world(on)
  mock.clock(on)
  await $.session.start(START)

  const spec = w.tools.find(t => t.name === 'show')
  expect(spec?.inputSchema).toMatchObject({ required: ['id', 'panels'] })

  const first = await call($, { id: 'plot-check', title: 'Plot check', panels: [{ kind: 'markdown', text: '**22 cards** in all' }] })
  expect(first).toEqual({ text: 'Pane "plot-check" created; drawn.' })
  expect(w.opens).toEqual([{ id: 'canvas-plot-check', title: 'Plot check' }])

  for (const surface of SURFACES) {
    const ui = await draw($, surface, 'plot-check')
    expect(await ui.find({ type: 'Markdown', text: /22 cards/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Plot check' })).toBeDefined()
  }

  const again = await call($, { id: 'plot-check', title: 'Plot check, redone', panels: [{ kind: 'markdown', text: 'now **23 cards**' }] })
  expect(again).toEqual({ text: 'Pane "plot-check" updated in place; drawn.' })
  // Same pane id, retitled: never a second pane.
  expect(w.opens.map(o => o.id)).toEqual(['canvas-plot-check', 'canvas-plot-check'])
  expect([...w.open]).toEqual(['canvas-plot-check'])
  expect((await $.command.run({ command: 'canvas', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })).text).toContain('Canvas panes (1):')

  for (const surface of SURFACES) {
    const ui = await draw($, surface, 'plot-check')
    expect(await ui.find({ type: 'Markdown', text: /23 cards/ })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: /22 cards/ })).toBeUndefined()
  }
  // The result never echoes the view back to the model.
  expect(JSON.stringify([first, again])).not.toContain('cards')
})

test('a pane that is not placed is reported, not hidden', async ($, on) => {
  world(on, { placed: false })
  mock.clock(on)
  await $.session.start(START)
  const out = await call($, { id: 'a', panels: [{ kind: 'markdown', text: 'hi' }] })
  expect(out).toEqual({ text: 'Pane "a" created; not drawn yet (the terminal is too narrow).' })
})

test('bad input is a clear tool error and opens nothing', async ($, on) => {
  const w = world(on)
  mock.clock(on)
  await $.session.start(START)
  const md = { kind: 'markdown', text: 'ok' }
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ['no id', { panels: [md] }, /id: expected 1-57/],
    ['id with a space', { id: 'a b', panels: [md] }, /id: expected/],
    ['id too long', { id: 'x'.repeat(58), panels: [md] }, /id: expected/],
    ['no panels', { id: 'a' }, /panels: expected an array/],
    ['empty panels', { id: 'a', panels: [] }, /panels: must not be empty/],
    ['unknown kind', { id: 'a', panels: [{ kind: 'chart' }] }, /panels\[0\]\.kind: expected markdown/],
    ['markdown without text', { id: 'a', panels: [{ kind: 'markdown' }] }, /panels\[0\]\.text/],
    ['table row of the wrong width', { id: 'a', panels: [md, { kind: 'table', columns: ['A', 'B'], rows: [['1']] }] }, /panels\[1\]\.rows\[0\]: 1 cells for 2 columns/],
    ['stats item without a value', { id: 'a', panels: [{ kind: 'stats', items: [{ label: 'Pens' }] }] }, /items\[0\]\.value/],
    ['svg with source and path', { id: 'a', panels: [{ kind: 'svg', source: SVG(100), path: '/a.svg', alt: 'x' }] }, /exactly one of "source"/],
    ['svg with a relative path', { id: 'a', panels: [{ kind: 'svg', path: 'a.svg', alt: 'x' }] }, /absolute path/],
    ['svg that is not svg', { id: 'a', panels: [{ kind: 'svg', source: '<div/>', alt: 'x' }] }, /expected an <svg/],
    ['svg without alt', { id: 'a', panels: [{ kind: 'svg', path: '/a.svg' }] }, /alt/],
    ['button with run and prompt', { id: 'a', panels: [{ kind: 'actions', buttons: [{ label: 'B', run: 'x', prompt: 'y' }] }] }, /exactly one of "run"/],
    ['button with neither', { id: 'a', panels: [{ kind: 'actions', buttons: [{ label: 'B' }] }] }, /exactly one of "run"/],
    ['run is a command line, not a name', { id: 'a', panels: [{ kind: 'actions', buttons: [{ label: 'B', run: 'rm -rf /' }] }] }, /expected a command name/],
    ['a view too heavy to keep', { id: 'a', panels: [1, 2, 3].map(n => ({ kind: 'svg', source: SVG(900_000), alt: `p${n}` })) }, /characters in all, the limit is 2000000/],
    ['media without a set', { id: 'a', panels: [{ kind: 'media' }] }, /panels\[0\]\.set/],
    ['refresh without a command', { id: 'a', panels: [md], refresh: { everySeconds: 10 } }, /refresh\.run/],
    ['refresh interval not a number', { id: 'a', panels: [md], refresh: { everySeconds: 'soon', run: 'x' } }, /refresh\.everySeconds/],
  ]
  for (const [name, input, message] of cases) {
    const out = await call($, input)
    expect(out, name).toMatchObject({ deny: expect.stringMatching(/^canvas show: /) })
    expect('deny' in out ? out.deny : '', name).toMatch(message)
  }
  expect(w.opens).toEqual([])
  expect(await call($, { id: 'ok', panels: [md] })).toEqual({ text: 'Pane "ok" created; drawn.' })
})

test('control characters in titles and text are stripped before they reach a drawing', async ($, on) => {
  const w = world(on)
  mock.clock(on)
  await $.session.start(START)
  await call($, { id: 'a', title: 'Bell\u0007 title\n2', panels: [{ kind: 'markdown', text: 'a\u001b[31mb\r\nc' }] })
  expect(w.opens[0]?.title).toBe('Bell title 2')
  const ui = await draw($, 'desktop', 'a')
  expect((await ui.find({ type: 'Markdown' }))?.text).toBe('a[31mb\nc')
})

test('stats, table and markdown draw on both surfaces', async ($, on) => {
  world(on)
  mock.clock(on)
  await $.session.start(START)
  await call($, {
    id: 'plot',
    title: 'Breach Tarot',
    panels: [
      { kind: 'stats', items: [{ label: 'Pens', value: '3' }, { label: 'Travel', value: '41 m' }] },
      { kind: 'table', columns: ['Card', 'Time', 'Check'], rows: [['0 Fool', '6:10', 'a | b'], ['1 Mage', 7, true]] },
    ],
  })
  for (const surface of SURFACES) {
    const ui = await draw($, surface, 'plot')
    expect(await ui.find({ type: 'Text', text: 'Pens' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '41 m' })).toBeDefined()
    const table = await ui.find({ type: 'Markdown', text: /Card/ })
    expect(table?.props.text).toBe(
      ['| Card | Time | Check |', '| --- | --- | --- |', '| 0 Fool | 6:10 | a \\| b |', '| 1 Mage | 7 | true |'].join('\n'),
    )
  }
})

test('svg: drawn on the desktop, its alt on a terminal, too large over the budget', async ($, on) => {
  const w = world(on, { files: { '/abs/preview.svg': SVG(2000), '/abs/huge.svg': SVG(130_000) } })
  mock.clock(on)
  await $.session.start(START)
  await call($, {
    id: 'pic',
    panels: [
      { kind: 'svg', source: SVG(500), alt: 'inline picture' },
      { kind: 'svg', path: '/abs/preview.svg', alt: 'file picture' },
      { kind: 'svg', path: '/abs/huge.svg', alt: 'huge picture' },
      { kind: 'svg', path: '/abs/gone.svg', alt: 'missing picture' },
    ],
  })

  const terminal = await draw($, 'terminal', 'pic')
  expect(await terminal.find({ type: 'Svg' })).toBeUndefined()
  for (const alt of ['inline picture', 'file picture', 'huge picture', 'missing picture']) {
    expect(await terminal.find({ type: 'Text', text: alt }), alt).toBeDefined()
  }

  const desktop = await draw($, 'desktop', 'pic')
  expect((await desktop.findAll({ type: 'Svg' })).map(s => s.props.alt)).toEqual(['inline picture', 'file picture'])
  expect(await desktop.find({ type: 'Text', text: 'huge picture - too large to draw' }), 'huge').toBeDefined()
  expect(await desktop.find({ type: 'Text', text: 'missing picture - could not read gone.svg' }), 'missing').toBeDefined()
  expect(w.writes).toBe(0)
})

test('svg: one pane draws up to the page budget in all', async ($, on) => {
  world(on)
  mock.clock(on)
  await $.session.start(START)
  const panels = [1, 2, 3].map(n => ({ kind: 'svg', source: SVG(100_000), alt: `picture ${n}` }))
  await call($, { id: 'budget', panels })
  const ui = await draw($, 'desktop', 'budget')
  expect((await ui.findAll({ type: 'Svg' })).map(s => s.props.alt)).toEqual(['picture 1', 'picture 2'])
  expect(await ui.find({ type: 'Text', text: 'picture 3 - too large to draw' })).toBeDefined()
})

test('svg wider than the pane is sized to the pane', async ($, on) => {
  world(on)
  mock.clock(on)
  await $.session.start(START)
  await call($, {
    id: 'wide',
    panels: [
      { kind: 'svg', source: SVG(300, 'width="800" height="400"'), alt: 'wide' },
      { kind: 'svg', source: SVG(300, 'viewBox="0 0 900 300"'), alt: 'boxed' },
      { kind: 'svg', source: SVG(300, 'width="200" height="100"'), alt: 'narrow' },
    ],
  })
  const ui = await draw($, 'desktop', 'wide', 40) // 40 columns, about 320 px
  const widths = Object.fromEntries((await ui.findAll({ type: 'Svg' })).map(s => [s.props.alt, s.props.width]))
  expect(widths).toEqual({ wide: 320, boxed: 320, narrow: undefined })
})

test('run buttons resolve only through the allowlist', async ($, on) => {
  const w = world(on, {
    files: allow({
      'plotter-check': { argv: ['npm', 'run', 'plotter-check'], cwd: '~/git/hatch3d' },
      shorthand: ['npm', 'run', 'x'],
      empty: { argv: [] },
    }),
    exec: argv => (argv[2] === 'plotter-check' ? { exitCode: 0, stdout: 'SECRET-OUTPUT' } : { exitCode: 0 }),
  })
  mock.clock(on)
  await $.session.start(START)
  const out = await call($, {
    id: 'acts',
    panels: [
      {
        kind: 'actions',
        buttons: [
          { label: 'Re-check', run: 'plotter-check' },
          { label: 'Wipe', run: 'wipe-everything' },
          { label: 'Shorthand', run: 'shorthand' },
          { label: 'Empty', run: 'empty' },
          { label: 'Ask Claude', prompt: 'Why does card 7 fail?' },
        ],
      },
    ],
  })
  expect(out).toMatchObject({
    text: expect.stringContaining('draw as "not allowed" and a refresh will not run: wipe-everything, shorthand, empty.'),
  })

  for (const surface of SURFACES) {
    const ui = await draw($, surface, 'acts')
    expect(await ui.find({ type: 'Button', text: 'Re-check' })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: 'not allowed: wipe-everything' })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: 'not allowed: shorthand' })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: 'not allowed: empty' })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: 'Wipe' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', text: 'Ask Claude' })).toBeDefined()
  }

  const ui = await draw($, 'desktop', 'acts')
  await ui.press({ key: 'a0-0' })
  expect(w.runs).toEqual([{ argv: ['npm', 'run', 'plotter-check'], cwd: `${HOME}/git/hatch3d`, timeoutMs: 120_000 }])
  expect(w.toasts).toEqual(['Re-check: done'])

  w.exec = () => ({ exitCode: 2, stdout: 'SECRET-OUTPUT' })
  await ui.press({ key: 'a0-0' })
  expect(w.toasts).toEqual(['Re-check: done', 'Re-check: failed (exit 2)'])

  // An unknown name does nothing but say so; no command starts.
  await ui.press({ key: 'a0-1' })
  expect(w.runs.length).toBe(2)
  expect(w.toasts.at(-1)).toBe('Wipe: wipe-everything is not in the command allowlist')
  // No argv and no output reaches any text the person reads.
  expect(w.toasts.join('\n')).not.toMatch(/npm|SECRET/)
  expect(w.writes).toBe(0)
})

test('a missing allowlist file is an empty allowlist and is never created', async ($, on) => {
  const w = world(on) // no files at all
  mock.clock(on)
  await $.session.start(START)
  const out = await call($, {
    id: 'acts',
    panels: [{ kind: 'actions', buttons: [{ label: 'Go', run: 'go' }] }],
    refresh: { everySeconds: 10, run: 'status' },
  })
  expect(out).toMatchObject({ text: expect.stringContaining('go, status.') })
  for (const surface of SURFACES) {
    const ui = await draw($, surface, 'acts')
    expect(await ui.find({ type: 'Button', text: 'not allowed: go' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'refresh not allowed: status' })).toBeDefined()
  }
  expect(w.writes).toBe(0)
  expect(w.runs).toEqual([])
})

test('a file that is not JSON allows nothing', async ($, on) => {
  const w = world(on, { files: { [COMMANDS]: '{ not json' } })
  mock.clock(on)
  await $.session.start(START)
  await call($, { id: 'acts', panels: [{ kind: 'actions', buttons: [{ label: 'Go', run: 'go' }] }] })
  const ui = await draw($, 'desktop', 'acts')
  expect(await ui.find({ type: 'Button', text: 'not allowed: go' })).toBeDefined()
  expect(w.runs).toEqual([])
})

test('the commandsFile option names the allowlist', { options: { commandsFile: '/etc/canvas/cmds.json' } }, async ($, on) => {
  const w = world(on, { files: { '/etc/canvas/cmds.json': JSON.stringify({ go: { argv: ['true'] } }), [COMMANDS]: '{}' } })
  mock.clock(on)
  await $.session.start(START)
  await call($, { id: 'acts', panels: [{ kind: 'actions', buttons: [{ label: 'Go', run: 'go' }] }] })
  const ui = await draw($, 'terminal', 'acts')
  await ui.press({ key: 'a0-0' })
  expect(w.runs).toEqual([{ argv: ['true'], cwd: undefined, timeoutMs: 120_000 }])
})

test('prompt buttons fill the draft and never submit', async ($, on) => {
  const w = world(on)
  mock.clock(on)
  await $.session.start(START)
  await call($, { id: 'ask', panels: [{ kind: 'actions', buttons: [{ label: 'Ask Claude', prompt: 'Why does card 7 fail the check?' }] }] })
  for (const surface of SURFACES) {
    const ui = await draw($, surface, 'ask')
    await ui.press({ key: 'a0-0' })
  }
  expect(w.fills).toEqual([
    { text: 'Why does card 7 fail the check?', mode: 'append' },
    { text: 'Why does card 7 fail the check?', mode: 'append' },
  ])
  expect(w.submits).toBe(0)
  expect(w.runs).toEqual([])
})

test('refresh patches the panels; a failure keeps the last ones with a dim line', async ($, on) => {
  const patch = (text: string) => JSON.stringify([{ index: 0, panel: { kind: 'markdown', text } }])
  let reply: { exitCode: number; stdout?: string } = { exitCode: 0, stdout: patch('41 m travel') }
  const w = world(on, { files: allow({ 'plot-status': { argv: ['plot-status', '--json'] } }), exec: () => reply })
  const clock = mock.clock(on)
  await $.session.start(START)
  const out = await call($, {
    id: 'live',
    panels: [{ kind: 'markdown', text: 'starting' }, { kind: 'markdown', text: 'static' }],
    refresh: { everySeconds: 15, run: 'plot-status' },
  })
  expect(out).toEqual({ text: 'Pane "live" created; drawn.' })

  await clock.advance(14_000)
  expect(w.runs).toEqual([])
  await clock.advance(1_000)
  expect(w.runs).toEqual([{ argv: ['plot-status', '--json'], cwd: undefined, timeoutMs: 60_000 }])
  for (const surface of SURFACES) {
    const ui = await draw($, surface, 'live')
    expect((await ui.findAll({ type: 'Markdown' })).map(m => m.props.text)).toEqual(['41 m travel', 'static'])
    expect(await ui.find({ type: 'Text', text: /refresh failed/ })).toBeUndefined()
  }

  // Each kind of failure keeps the last panels and shows the dim line.
  const failures: { exitCode: number; stdout?: string }[] = [
    { exitCode: 1, stdout: patch('from a failed run') },
    { exitCode: 0, stdout: 'not json' },
    { exitCode: 0, stdout: '{"index":0}' },
    { exitCode: 0, stdout: JSON.stringify([{ index: 5, panel: { kind: 'markdown', text: 'out of range' } }]) },
    { exitCode: 0, stdout: JSON.stringify([{ index: 0, panel: { kind: 'chart' } }]) },
  ]
  for (const failure of failures) {
    reply = failure
    await clock.advance(15_000)
    for (const surface of SURFACES) {
      const ui = await draw($, surface, 'live')
      expect((await ui.findAll({ type: 'Markdown' })).map(m => m.props.text), JSON.stringify(failure)).toEqual(['41 m travel', 'static'])
      expect(await ui.find({ type: 'Text', text: 'refresh failed: plot-status' }), JSON.stringify(failure)).toBeDefined()
    }
  }

  // The next good run clears the line.
  reply = { exitCode: 0, stdout: patch('44 m travel') }
  await clock.advance(15_000)
  const ui = await draw($, 'desktop', 'live')
  expect((await ui.findAll({ type: 'Markdown' })).map(m => m.props.text)).toEqual(['44 m travel', 'static'])
  expect(await ui.find({ type: 'Text', text: /refresh failed/ })).toBeUndefined()
  expect(w.runs.length).toBe(7)
})

test('a refresh interval under 5 s is raised to 5 s and the model is told', async ($, on) => {
  const w = world(on, { files: allow({ s: { argv: ['s'] } }) })
  const clock = mock.clock(on)
  await $.session.start(START)
  const out = await call($, { id: 'fast', panels: [{ kind: 'markdown', text: 'x' }], refresh: { everySeconds: 1, run: 's' } })
  expect(out).toMatchObject({ text: expect.stringContaining('refresh.everySeconds was set to 5') })
  await clock.advance(4_000)
  expect(w.runs.length).toBe(0)
  await clock.advance(1_000)
  expect(w.runs.length).toBe(1)
})

test('showing again without refresh, and /canvas close, stop the timer', async ($, on) => {
  const w = world(on, { files: allow({ s: { argv: ['s'] } }), exec: () => ({ exitCode: 0, stdout: '[]' }) })
  const clock = mock.clock(on)
  await $.session.start(START)
  const run = (args: string) => $.command.run({ command: 'canvas', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

  await call($, { id: 'a', panels: [{ kind: 'markdown', text: 'x' }], refresh: { everySeconds: 10, run: 's' } })
  await call($, { id: 'b', panels: [{ kind: 'markdown', text: 'x' }], refresh: { everySeconds: 10, run: 's' } })
  await clock.advance(10_000)
  expect(w.runs.length).toBe(2)

  // Re-showing a refreshing pane replaces its timer rather than adding one.
  await call($, { id: 'a', panels: [{ kind: 'markdown', text: 'y' }], refresh: { everySeconds: 10, run: 's' } })
  await clock.advance(10_000)
  expect(w.runs.length).toBe(4)

  // Dropping `refresh` from the view stops it.
  await call($, { id: 'a', panels: [{ kind: 'markdown', text: 'z' }] })
  await clock.advance(10_000)
  expect(w.runs.length).toBe(5)

  expect((await run('close b')).text).toBe('Closed "b".')
  expect(w.closes).toEqual(['canvas-b'])
  await clock.advance(30_000)
  expect(w.runs.length).toBe(5)
})

test('/canvas lists open panes and closes one', async ($, on) => {
  const w = world(on, { files: allow({ s: { argv: ['s'] } }) })
  mock.clock(on)
  await $.session.start(START)
  const run = async (args: string) =>
    (await $.command.run({ command: 'canvas', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })).text

  expect(await run('')).toBe('No canvas panes are open.')
  await call($, { id: 'plot-check', title: 'Breach Tarot', panels: [{ kind: 'markdown', text: 'x' }], refresh: { everySeconds: 15, run: 's' } })
  await call($, { id: 'notes', panels: [{ kind: 'markdown', text: 'y' }] })
  expect(await run('')).toBe(
    ['Canvas panes (2):', '- plot-check - Breach Tarot (refreshes every 15 s)', '- notes', 'Close one with /canvas close <id>.'].join('\n'),
  )
  expect(await run('list')).toBe(await run(''))

  expect(await run('close nope')).toBe('No canvas pane "nope". Open: plot-check, notes.')
  expect(await run('close')).toMatch(/^Usage:/)
  expect(await run('what')).toMatch(/^Usage:/)
  expect(w.closes).toEqual([])

  expect(await run('close plot-check')).toBe('Closed "plot-check".')
  expect(w.closes).toEqual(['canvas-plot-check'])
  expect(await run('')).toBe(['Canvas panes (1):', '- notes', 'Close one with /canvas close <id>.'].join('\n'))

  // A pane the engine no longer has open (closed another way) drops out of the list.
  w.open.delete('canvas-notes')
  expect(await run('')).toBe('No canvas panes are open.')
  // Showing it again makes a fresh pane.
  expect(await call($, { id: 'notes', panels: [{ kind: 'markdown', text: 'again' }] })).toEqual({ text: 'Pane "notes" created; drawn.' })
})

test('panes live in $.state: a restart of the session re-arms their refresh once and keeps them', async ($, on) => {
  const patch = JSON.stringify([{ index: 0, panel: { kind: 'markdown', text: 'patched' } }])
  const w = world(on, { files: allow({ s: { argv: ['s'] } }), exec: () => ({ exitCode: 0, stdout: patch }) })
  const clock = mock.clock(on)
  await $.session.start(START)
  await call($, { id: 'live', panels: [{ kind: 'markdown', text: 'first' }], refresh: { everySeconds: 10, run: 's' } })
  await call($, { id: 'gone', panels: [{ kind: 'markdown', text: 'x' }], refresh: { everySeconds: 10, run: 's' } })

  // A hot reload runs session.start again over the state the old module left.
  // `gone` was closed in the meantime by something this module never heard of.
  w.open.delete('canvas-gone')
  await $.session.start(START)
  expect(w.tools.map(t => t.name)).toEqual(['show', 'curate', 'show', 'curate'])

  for (const surface of SURFACES) {
    const ui = await draw($, surface, 'live')
    expect(await ui.find({ type: 'Markdown', text: 'first' })).toBeDefined()
  }
  await clock.advance(10_000)
  expect(w.runs.length).toBe(1) // one timer for `live`, none for `gone`, no doubled ones
  const ui = await draw($, 'desktop', 'live')
  expect(await ui.find({ type: 'Markdown', text: 'patched' })).toBeDefined()
  expect((await $.command.run({ command: 'canvas', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })).text).toContain('- live (refreshes every 10 s)')
})

test('a refresh that finishes after a newer show leaves the newer view alone', async ($, on) => {
  const patch = JSON.stringify([{ index: 0, panel: { kind: 'markdown', text: 'stale patch' } }])
  let release: (() => void) | undefined
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  // The command takes a while: its answer is held until the test lets it go.
  const w = world(on, {
    files: allow({ s: { argv: ['s'] } }),
    exec: async () => {
      await gate
      return { exitCode: 0, stdout: patch }
    },
  })
  const clock = mock.clock(on)
  await $.session.start(START)
  await call($, { id: 'race', panels: [{ kind: 'markdown', text: 'v1' }], refresh: { everySeconds: 10, run: 's' } })
  await clock.advance(10_000)
  expect(w.runs.length).toBe(1)
  await call($, { id: 'race', panels: [{ kind: 'markdown', text: 'v2' }], refresh: { everySeconds: 10, run: 's' } })
  release?.()
  await clock.settle()
  const ui = await draw($, 'desktop', 'race')
  expect(await ui.find({ type: 'Markdown', text: 'v2' })).toBeDefined()
  expect(await ui.find({ type: 'Markdown', text: 'stale patch' })).toBeUndefined()
})
