import type { Elements } from 'claude-code'

import type { PreviewEntry, SetItem, SetRecord, Verdict } from '../types'
import { fetchPreviews, previewId, reloadSet, reopenSet, runAction } from './curate'
import type { Host, MediaAction, Want } from './curate'
import {
  FOCUS_MAX_PX,
  LIST_PREVIEW_PX,
  PX_PER_COLUMN,
  SVG_ELEMENT_MAX,
  cardColumns,
  planPage,
  widthPx,
} from './layout'
import type { Page } from './layout'
import { countsOf, formatMeta, guessKind, kindGlyph, quoteLabel, reasonText, withPlayhead } from './setmodel'

// The media panel: one renderer for a curate pane and for the `media` panel of a `show` pane.
// It takes the elements of the surface (never `$`), reads its state through `Host`, and turns the
// set into rows, cards or one large item by the pane's width. Every item draws something: a
// picture, a few lines of text, or a card with its label, key numbers and the reason there is no picture.

type Desktop = Elements['desktop']
/** The elements the panel uses; `Svg` is absent where a surface draws no pictures (the terminal). */
export type Kit = Pick<Desktop, 'Box' | 'Text' | 'Button' | 'Markdown'> & { Svg?: Desktop['Svg'] }

export type MediaOptions = {
  /** The set's key in $.state. */
  key: string
  /** The panel's place among its pane's panels: keeps element keys apart. */
  index: number
  /** Whether this panel owns the pane's hotkeys (one panel per pane may). */
  hotkeys: boolean
  /** The pane's `bodyColumns`. */
  columns: number
  /** Svg characters the panel may draw in all; a `show` pane has other pictures to count. */
  pageBudget: number
  /** A `show` panel names its set file: if the set is not open (state was lost) it is opened again. */
  reopen?: string
}

type Ctx = {
  kit: Kit
  /** Prefix of every element key. */
  p: string
  columns: number
  record: SetRecord
  dispatch: (action: MediaAction) => void
  hotkeys: boolean
  /** Characters of Svg this drawing may still add. */
  svgLeft: number
  /** What one item's Svg may weigh (the page's budget divided by its items). */
  itemBudget: number
}

const VERDICT_COLOR: Record<Verdict, string> = { keep: 'success', pick: 'success', maybe: 'warning', toss: 'error' }
const MODE_WORD: Record<string, string> = { 'pick-one': 'pick one', 'pick-many': 'pick many', triage: 'triage', rate: 'rate' }

const isPick = (mode: string): boolean => mode === 'pick-one' || mode === 'pick-many'

function fit(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`
}

function firstLines(text: string, lines: number, chars: number): string {
  const head = text.split('\n').slice(0, lines).join('\n')
  return head.length <= chars ? head : `${head.slice(0, chars - 1)}…`
}

// ---- the entry point --------------------------------------------------------------------

/**
 * Draws the set `opt.key`. Reads its state through `host` (so the drawing follows it), starts the
 * previews and the reload it finds missing for after the drawing ends, and says how much Svg it used.
 */
export async function renderMediaPanel(host: Host, kit: Kit, opt: MediaOptions): Promise<{ tree: JSX.Element; svgUsed: number }> {
  const { Box, Text } = kit
  const record = await host.getSet(opt.key)
  if (!record) {
    const path = opt.reopen
    if (path !== undefined) host.later(0, () => void reopenSet(host, opt.key, path).catch(() => undefined))
    return { tree: <Text dimColor>{path === undefined ? 'This set is not open any more.' : 'Opening the set…'}</Text>, svgUsed: 0 }
  }

  // The file may have been changed by something else (or by Claude): a newer mtime reloads it.
  let isMissing = false
  try {
    const stat = await host.stat(record.path)
    if (stat.mtimeMs !== record.mtimeMs) host.later(0, () => void reloadSet(host, opt.key).catch(() => undefined))
  } catch {
    isMissing = true
  }

  const items = record.data.items
  const page = planPage(items.length, record.cursor, opt.columns, record.isFocus, opt.pageBudget)
  const here = items.slice(page.start, page.end)
  const entries = new Map<string, PreviewEntry | null>()
  const wants: Want[] = []
  if (page.budget > 0) {
    for (const item of here) {
      if (item.isUrl) continue
      const entry = await host.getPreview(previewId(opt.key, item.id, page.budget))
      entries.set(item.id, entry)
      if (!entry) wants.push({ itemId: item.id, where: item.where, budget: page.budget })
    }
  }
  if (wants.length > 0) host.later(0, () => fetchPreviews(host, opt.key, wants))

  const ctx: Ctx = {
    kit,
    p: `m${opt.index}`,
    columns: opt.columns,
    record,
    dispatch: action => void runAction(host, opt.key, action),
    hotkeys: opt.hotkeys,
    svgLeft: opt.pageBudget,
    itemBudget: page.budget,
  }

  const cursorItem = items[record.cursor]
  const body = items.length === 0 ? <Text dimColor>This set has no items.</Text> : drawPage(ctx, page, here, entries)
  const tree = (
    <Box flexDirection="column" gap={1}>
      {header(ctx)}
      {items.length > 0 && cursorItem ? toolbar(ctx, cursorItem) : null}
      {record.isStale ? <Text color="warning">The set file changed and can't be read now; showing the last copy.</Text> : null}
      {isMissing ? <Text color="warning">The set file is missing.</Text> : null}
      {body}
    </Box>
  )
  return { tree, svgUsed: opt.pageBudget - ctx.svgLeft }
}

// ---- header and toolbar ------------------------------------------------------------------------------

function headerText(record: SetRecord): string {
  const { items, mode, isHandedOff } = record.data
  const c = countsOf(items)
  const bits = [MODE_WORD[mode] ?? mode, `${items.length} ${items.length === 1 ? 'item' : 'items'}`]
  if (mode === 'rate') bits.push(`rated ${c.rated}`)
  bits.push(`${isPick(mode) ? 'picked' : 'kept'} ${c.keep}`)
  if (!isPick(mode) || c.maybe > 0) bits.push(`maybe ${c.maybe}`)
  if (!isPick(mode) || c.toss > 0) bits.push(`tossed ${c.toss}`)
  bits.push(`${c.unreviewed} to go`)
  if (isHandedOff) bits.push('sent to Claude')
  return bits.join(' · ')
}

function header(ctx: Ctx): JSX.Element {
  const { Box, Text } = ctx.kit
  const { record } = ctx
  const total = record.data.items.length
  return (
    <Box flexDirection="column">
      <Text bold>{quoteLabel(record.data.title)}</Text>
      <Text dimColor>{headerText(record)}</Text>
      {total > 0 ? <Text dimColor>{`item ${record.cursor + 1} of ${total}`}</Text> : null}
    </Box>
  )
}

function toolbar(ctx: Ctx, item: SetItem): JSX.Element {
  const { Box, Button } = ctx.kit
  const { record, p, dispatch } = ctx
  const rate = record.data.mode === 'rate'
  const hot = (key: string) => (ctx.hotkeys ? { hotkey: key } : {})
  const isPlaying = record.playing === item.id
  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
      <Button key={`${p}:hk:prev`} label="prev" {...hot('k')} onPress={() => dispatch({ t: 'move', delta: -1 })} />
      <Button key={`${p}:hk:next`} label="next" {...hot('j')} onPress={() => dispatch({ t: 'move', delta: 1 })} />
      <Button key={`${p}:hk:keep`} label={isPick(record.data.mode) ? 'pick' : 'keep'} {...hot('y')} onPress={() => dispatch({ t: 'verdict', verdict: 'keep' })} />
      <Button key={`${p}:hk:toss`} label="toss" {...hot('n')} onPress={() => dispatch({ t: 'verdict', verdict: 'toss' })} />
      <Button key={`${p}:hk:maybe`} label="maybe" {...hot('m')} onPress={() => dispatch({ t: 'verdict', verdict: 'maybe' })} />
      {rate
        ? [1, 2, 3, 4, 5].map(n => (
            <Button key={`${p}:hk:r${n}`} label={String(n)} {...hot(String(n))} onPress={() => dispatch({ t: 'rate', rating: n })} />
          ))
        : null}
      <Button key={`${p}:hk:clear`} label="clear" {...hot('x')} onPress={() => dispatch({ t: 'verdict', verdict: 'clear' })} />
      <Button key={`${p}:hk:play`} label={isPlaying ? 'stop' : 'play'} {...hot('p')} onPress={() => dispatch({ t: 'play' })} />
      <Button key={`${p}:hk:open`} label="open" {...hot('o')} onPress={() => dispatch({ t: 'open' })} />
      <Button key={`${p}:hk:focus`} label={record.isFocus ? 'list' : 'focus'} {...hot('f')} onPress={() => dispatch({ t: 'focus' })} />
      <Button key={`${p}:hk:done`} label="done" variant="primary" {...hot('d')} onPress={() => dispatch({ t: 'done' })} />
    </Box>
  )
}

// ---- one item's parts -------------------------------------------------------------------------------------

/** The item's verdict (or rating) as a coloured word; nothing for an item not yet reviewed. */
function badges(ctx: Ctx, item: SetItem): JSX.Element[] {
  const { Text } = ctx.kit
  const bits: JSX.Element[] = []
  if (item.verdict) bits.push(<Text bold color={VERDICT_COLOR[item.verdict]}>{item.verdict}</Text>)
  if (item.rating !== null) bits.push(<Text bold color="claude">{`${item.rating}/5`}</Text>)
  if (ctx.record.playing === item.id) bits.push(<Text color="suggestion">playing</Text>)
  return bits
}

/** The row's own verdict buttons (clicks only: the hotkeys belong to the toolbar). */
function rowButtons(ctx: Ctx, item: SetItem, glyphs: boolean): JSX.Element {
  const { Box, Button } = ctx.kit
  const { p, dispatch, record } = ctx
  const on = (active: boolean) => ({ variant: active ? ('primary' as const) : ('secondary' as const) })
  if (record.data.mode === 'rate') {
    return (
      <Box flexDirection="row" columnGap={1}>
        {[1, 2, 3, 4, 5].map(n => (
          <Button key={`${p}:rate:${item.id}:${n}`} label={String(n)} {...on(item.rating === n)} onPress={() => dispatch({ t: 'rate', rating: n, id: item.id })} />
        ))}
      </Box>
    )
  }
  const keepLabel = isPick(record.data.mode) ? (glyphs ? '★' : 'pick') : glyphs ? '✓' : 'keep'
  const kept = item.verdict === 'keep' || item.verdict === 'pick'
  return (
    <Box flexDirection="row" columnGap={1}>
      <Button key={`${p}:v:${item.id}:keep`} label={keepLabel} {...on(kept)} onPress={() => dispatch({ t: 'verdict', verdict: 'keep', id: item.id })} />
      <Button key={`${p}:v:${item.id}:toss`} label={glyphs ? '✗' : 'toss'} {...on(item.verdict === 'toss')} onPress={() => dispatch({ t: 'verdict', verdict: 'toss', id: item.id })} />
      <Button key={`${p}:v:${item.id}:maybe`} label={glyphs ? '?' : 'maybe'} {...on(item.verdict === 'maybe')} onPress={() => dispatch({ t: 'verdict', verdict: 'maybe', id: item.id })} />
    </Box>
  )
}

/** The item's label as a button that moves the cursor to it. */
function labelButton(ctx: Ctx, item: SetItem, index: number, max: number): JSX.Element {
  const { Button, Text } = ctx.kit
  const isCursor = index === ctx.record.cursor
  const kind = ctx.record.learned[item.id]?.kind ?? guessKind(item.where, item.isUrl)
  return (
    <Button key={`${ctx.p}:go:${item.id}`} plain onPress={() => ctx.dispatch({ t: 'goto', index })}>
      {isCursor ? '▸ ' : '  '}
      {kindGlyph(kind)} <Text bold={isCursor}>{quoteLabel(item.label, max)}</Text>
    </Button>
  )
}

function metaOf(item: SetItem, entry: PreviewEntry | null | undefined, full: boolean): string {
  const p = entry?.preview
  return p ? formatMeta(p.meta, full) : item.isUrl ? 'link' : ''
}

function card(ctx: Ctx, glyphKind: string, lines: string[], width?: number): JSX.Element {
  const { Box, Text } = ctx.kit
  return (
    <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} flexShrink={0} {...(width ? { width } : {})}>
      <Text>{`${kindGlyph(glyphKind)} ${glyphKind}`}</Text>
      {lines.filter(line => line !== '').map(line => (
        <Text dimColor>{line}</Text>
      ))}
    </Box>
  )
}

/**
 * The picture slot of one item: its Svg if the surface draws one and it fits what is left of the
 * page's budget, else its text, else a card saying what the file is and why there is no picture.
 */
function picture(ctx: Ctx, item: SetItem, entry: PreviewEntry | null | undefined, px: number, cols: number, full: boolean): JSX.Element {
  const { Box, Markdown } = ctx.kit
  const Svg = ctx.kit.Svg
  const guess = guessKind(item.where, item.isUrl)
  const fallback = (lines: string[], kind: string = guess) => card(ctx, kind, lines, full ? undefined : cols)
  if (item.isUrl) return fallback(['link', 'press o to open it'])
  if (!entry) return fallback(['loading…'])
  const p = entry.preview
  if (!p) return fallback([reasonText(null)])

  if (p.svg !== null) {
    if (!Svg) return fallback([formatMeta(p.meta, full), 'pictures need the desktop app'], p.kind)
    const playhead = p.kind === 'audio' && ctx.record.playing === item.id ? withPlayhead(p.svg, p.meta.duration) : null
    const source = playhead ?? p.svg
    const weight = source.length
    // Whatever the CLI sent, one Svg stays under the element cap, the item's share and what the page has left.
    if (weight > Math.min(SVG_ELEMENT_MAX, ctx.itemBudget) || weight > ctx.svgLeft) return fallback([formatMeta(p.meta, full), reasonText('budget')], p.kind)
    ctx.svgLeft -= weight
    const alt = `${p.kind} preview of ${quoteLabel(item.label)}${playhead ? ', playing' : ''}`
    // A playhead animates (SMIL), which only the sandboxed frame of an interactive Svg runs.
    return playhead ? <Svg source={source} alt={alt} width={px} isInteractive /> : <Svg source={source} alt={alt} width={px} />
  }
  if (p.markdown !== null) {
    const text = full ? p.markdown : firstLines(p.markdown, 5, 400)
    return (
      <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} flexShrink={0} {...(full ? {} : { width: cols })}>
        <Markdown text={text} />
      </Box>
    )
  }
  return fallback([formatMeta(p.meta, full), reasonText(p.reason)], p.kind)
}

// ---- the four tiers ----------------------------------------------------------------------------------------

function drawPage(ctx: Ctx, page: Page, here: readonly SetItem[], entries: ReadonlyMap<string, PreviewEntry | null>): JSX.Element {
  const { Box, Text } = ctx.kit
  const first = page.start
  const nav =
    page.end - page.start < ctx.record.data.items.length ? (
      <Text dimColor>{`showing ${page.start + 1}-${page.end} of ${ctx.record.data.items.length}`}</Text>
    ) : null

  switch (page.tier) {
    case 'compact':
      return (
        <Box flexDirection="column">
          {here.map((item, i) => compactRow(ctx, item, first + i))}
          {nav}
        </Box>
      )
    case 'list':
      return (
        <Box flexDirection="column">
          {here.map((item, i) => listRow(ctx, item, first + i, entries.get(item.id)))}
          {nav}
        </Box>
      )
    case 'grid': {
      const width = cardColumns(ctx.columns, page.perRow)
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            {here.map((item, i) => gridCard(ctx, item, first + i, entries.get(item.id), width))}
          </Box>
          {nav}
        </Box>
      )
    }
    case 'focus': {
      const item = here[0]
      return item ? focusView(ctx, item, first, entries.get(item.id)) : <Text dimColor>Nothing to show.</Text>
    }
  }
}

/** < 48 columns: glyph, label and verdict buttons on one line; no previews. */
function compactRow(ctx: Ctx, item: SetItem, index: number): JSX.Element {
  const { Box } = ctx.kit
  const buttons = ctx.record.data.mode === 'rate' ? 22 : ctx.record.data.mode === 'triage' ? 12 : 10
  const room = Math.max(8, ctx.columns - buttons - 12)
  return (
    <Box flexDirection="row" columnGap={1} flexWrap="wrap">
      {labelButton(ctx, item, index, room)}
      {badges(ctx, item)}
      {rowButtons(ctx, item, true)}
    </Box>
  )
}

const cursorBorder = (isCursor: boolean) => (isCursor ? { borderColor: 'claude' } : { borderDimColor: true })

/** 48-109 columns: a small preview, then label, numbers and the verdict buttons. */
function listRow(ctx: Ctx, item: SetItem, index: number, entry: PreviewEntry | null | undefined): JSX.Element {
  const { Box, Text } = ctx.kit
  const isCursor = index === ctx.record.cursor
  const slotColumns = Math.ceil(LIST_PREVIEW_PX / PX_PER_COLUMN) + 2
  const textRoom = Math.max(10, ctx.columns - slotColumns - 8)
  return (
    <Box flexDirection="row" columnGap={1} borderStyle="round" paddingX={1} {...cursorBorder(isCursor)}>
      <Box flexShrink={0}>
        {picture(ctx, item, entry, LIST_PREVIEW_PX, slotColumns, false)}
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {labelButton(ctx, item, index, textRoom)}
        <Text dimColor>{metaOf(item, entry, false)}</Text>
        <Box flexDirection="row" columnGap={1} flexWrap="wrap">
          {badges(ctx, item)}
          {rowButtons(ctx, item, false)}
        </Box>
      </Box>
    </Box>
  )
}

/** 110+ columns: cards, floor(columns / 34) to a row. */
function gridCard(ctx: Ctx, item: SetItem, index: number, entry: PreviewEntry | null | undefined, width: number): JSX.Element {
  const { Box, Text } = ctx.kit
  const isCursor = index === ctx.record.cursor
  const inner = Math.max(8, width - 4)
  return (
    <Box flexDirection="column" width={width} borderStyle="round" paddingX={1} {...cursorBorder(isCursor)}>
      {picture(ctx, item, entry, inner * PX_PER_COLUMN, inner, false)}
      {labelButton(ctx, item, index, inner)}
      <Text dimColor>{fit(metaOf(item, entry, false), inner)}</Text>
      <Box flexDirection="row" columnGap={1} flexWrap="wrap">
        {badges(ctx, item)}
      </Box>
      {rowButtons(ctx, item, false)}
    </Box>
  )
}

/** `f`: one item large, its numbers in full, with previous and next beside it. */
function focusView(ctx: Ctx, item: SetItem, index: number, entry: PreviewEntry | null | undefined): JSX.Element {
  const { Box, Text, Button } = ctx.kit
  const { p, dispatch } = ctx
  const px = Math.min(FOCUS_MAX_PX, widthPx(ctx.columns - 2))
  const last = ctx.record.data.items.length - 1
  return (
    <Box flexDirection="column" gap={1}>
      {picture(ctx, item, entry, px, Math.max(10, ctx.columns - 4), true)}
      <Box flexDirection="column">
        <Text bold>{quoteLabel(item.label)}</Text>
        <Text dimColor>{metaOf(item, entry, true)}</Text>
        {entry?.preview ? <Text dimColor>{`${entry.preview.kind}${entry.preview.mime ? ` · ${entry.preview.mime}` : ''}`}</Text> : null}
      </Box>
      <Box flexDirection="row" columnGap={1} flexWrap="wrap">
        {badges(ctx, item)}
        {rowButtons(ctx, item, false)}
      </Box>
      <Box flexDirection="row" columnGap={1}>
        {index > 0 ? <Button key={`${p}:fo:prev`} label="◂ previous" onPress={() => dispatch({ t: 'move', delta: -1 })} /> : null}
        {index < last ? <Button key={`${p}:fo:next`} label="next ▸" onPress={() => dispatch({ t: 'move', delta: 1 })} /> : null}
      </Box>
    </Box>
  )
}
