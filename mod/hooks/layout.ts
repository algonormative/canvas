// Pure layout math for the media panel: which tier a pane width gets, which items
// make a page, and how much picture each of them may weigh. Nothing here touches
// `$`; the arithmetic is the thing the Svg budget depends on, so it is tested alone.

/**
 * Characters of Svg source one drawn page holds in all. Probe C1 (2026-10-10): ~260k of
 * Svg in one desktop pane drew fine; one Svg over 131,072 characters is refused.
 */
export const SVG_PAGE_BUDGET = 240_000
/** One Svg: the probe-measured cap, under the engine's 131,072. */
export const SVG_ELEMENT_MAX = 120_000
/** Pixels per terminal column when a pane's width becomes an Svg width (probe: about 8). */
export const PX_PER_COLUMN = 8

/** Below this many columns: compact rows, no previews. */
export const COMPACT_BELOW = 48
/** From this many columns: a grid of cards. */
export const GRID_FROM = 110
/** A grid card is at least this many columns wide, so a row holds floor(columns / 34). */
export const GRID_CARD_COLUMNS = 34
/** The list tier's preview is about this many pixels wide. */
export const LIST_PREVIEW_PX = 120
/** The focus view never draws a picture wider than this, however wide the pane. */
export const FOCUS_MAX_PX = 720

const COMPACT_PAGE = 12
const LIST_PAGE = 6
const GRID_ROWS = 2

export type Tier = 'compact' | 'list' | 'grid' | 'focus'

export function tierFor(columns: number, isFocus: boolean): Tier {
  if (isFocus) return 'focus'
  if (columns < COMPACT_BELOW) return 'compact'
  return columns >= GRID_FROM ? 'grid' : 'list'
}

/** Cards per grid row: floor(columns / 34), never fewer than one. */
export function perRow(columns: number): number {
  return Math.max(1, Math.floor(columns / GRID_CARD_COLUMNS))
}

export type Page = {
  tier: Tier
  /** First item index on the page. */
  start: number
  /** One past the last item index. */
  end: number
  /** Cards per row (grid only; 1 elsewhere). */
  perRow: number
  /** The `--budget` each item's preview is asked for; 0 where the tier draws none. */
  budget: number
}

/** How many items a full page of this tier holds. */
export function pageSize(tier: Tier, columns: number): number {
  switch (tier) {
    case 'compact':
      return COMPACT_PAGE
    case 'list':
      return LIST_PAGE
    case 'grid':
      return perRow(columns) * GRID_ROWS
    case 'focus':
      return 1
  }
}

/**
 * Per-item preview budget: the page budget divided by the items on a page, capped at one Svg's
 * maximum and rounded down to a thousand so a few distinct values (and cache keys) serve every width.
 */
export function itemBudget(items: number, pageBudget: number = SVG_PAGE_BUDGET): number {
  if (items <= 0) return 0
  return Math.max(0, Math.floor(Math.min(SVG_ELEMENT_MAX, pageBudget / items) / 1000) * 1000)
}

/**
 * The page holding `cursor`. Pages are aligned (the cursor moving within one page changes no item
 * and no budget), so a preview fetched once is the one drawn until the cursor leaves the page.
 */
export function planPage(count: number, cursor: number, columns: number, isFocus: boolean, pageBudget: number = SVG_PAGE_BUDGET): Page {
  const tier = tierFor(columns, isFocus)
  const size = pageSize(tier, columns)
  const at = Math.min(Math.max(0, cursor), Math.max(0, count - 1))
  const start = Math.floor(at / size) * size
  const end = Math.min(count, start + size)
  const budget = tier === 'compact' ? 0 : itemBudget(Math.min(size, count), pageBudget)
  return { tier, start, end, perRow: tier === 'grid' ? perRow(columns) : 1, budget }
}

/** An Svg width in CSS pixels for `columns` terminal columns of room. */
export function widthPx(columns: number): number {
  return Math.max(24, Math.floor(columns) * PX_PER_COLUMN)
}

/** Width of one grid card in columns: the row's room less one gap between neighbours, shared out. */
export function cardColumns(columns: number, cardsPerRow: number): number {
  return Math.max(10, Math.floor((columns - (cardsPerRow - 1)) / cardsPerRow))
}
