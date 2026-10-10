import type { MediaMode, PreviewData, SetData, SetItem, Verdict } from '../types'

// Pure parts of the media panel: reading the set file and the CLIs' JSON defensively,
// the words the panel and the hand-off use, and the little tables behind them. Nothing
// here touches `$`. Everything that comes from outside (a file the model may have
// written, a CLI's stdout) is checked here once, so the drawing code trusts its input.

export const MODES: readonly MediaMode[] = ['pick-one', 'pick-many', 'triage', 'rate']
export const VERDICTS: readonly Verdict[] = ['keep', 'toss', 'maybe', 'pick']

/** Longest label (quotes included) that reaches a screen or a prompt. */
export const LABEL_MAX = 80
/** Most items a set may hold for the panel to take it (the page draws a few; the file keeps the rest). */
export const MAX_ITEMS = 5000
/** What the panel will take of a text preview, so one item cannot fill a drawing. */
export const MAX_MARKDOWN = 60_000

// Every C0/C1 control character, DEL and the Unicode line separators.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g

// eslint-disable-next-line no-control-regex
const HAS_CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** One line, control characters gone, at most `max` characters (an ellipsis marks a cut). */
export function oneLine(text: string, max: number): string {
  const flat = text.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/** A label as the panel and the prompt show it: in double quotes, `max` characters at most with them (80 by default). */
export function quoteLabel(label: string, max: number = LABEL_MAX): string {
  return `"${oneLine(label, Math.min(max, LABEL_MAX) - 2).replace(/"/g, "'")}"`
}

/**
 * A short stable key for a path (cyrb53, 53 bits, 14 hex digits): the name a set's state and its
 * pane go by. Never drawn: a pane id is not text anyone should read.
 */
export function keyOf(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0)
  return n.toString(16).padStart(14, '0')
}

// ---- the set file ------------------------------------------------------------------

/**
 * The set file's JSON reduced to what the panel draws, or null when it is not a version-1 set
 * (the file is checked properly by `canvas-set validate` before the mod first takes it; this
 * only keeps a file edited since from crashing a drawing).
 */
export function parseSetFile(text: string): SetData | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObject(raw) || raw.version !== 1 || typeof raw.title !== 'string' || typeof raw.done !== 'boolean') return null
  if (!MODES.includes(raw.mode as MediaMode) || !Array.isArray(raw.items) || raw.items.length > MAX_ITEMS) return null
  const items: SetItem[] = []
  const seen = new Set<string>()
  for (const one of raw.items) {
    if (!isObject(one) || typeof one.id !== 'string' || one.id === '' || seen.has(one.id)) return null
    seen.add(one.id)
    const isUrl = typeof one.url === 'string'
    const where = isUrl ? one.url : one.path
    if (typeof where !== 'string' || (isUrl && 'path' in one)) return null
    // Absolute paths and http(s) links only: the value reaches a command line (open, canvas-preview).
    if (isUrl ? !/^https?:\/\/\S+$/i.test(where) : !where.startsWith('/')) return null
    const verdict = one.verdict ?? null
    if (verdict !== null && !VERDICTS.includes(verdict as Verdict)) return null
    const rating = one.rating ?? null
    if (rating !== null && (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5)) return null
    const label = typeof one.label === 'string' && one.label.trim() !== '' ? one.label : one.id
    items.push({ id: one.id, where: where as string, isUrl, label: oneLine(label, 200), verdict: verdict as Verdict | null, rating })
  }
  const title = oneLine(raw.title, 100)
  if (title === '') return null
  return { title, mode: raw.mode as MediaMode, items, done: raw.done, isHandedOff: isObject(raw.handoff) }
}

export type Counts = { keep: number; maybe: number; toss: number; unreviewed: number; rated: number }

/** Tallies for the header line: keep and pick count together; a rating alone counts as reviewed. */
export function countsOf(items: readonly SetItem[]): Counts {
  const counts: Counts = { keep: 0, maybe: 0, toss: 0, unreviewed: 0, rated: 0 }
  for (const item of items) {
    if (item.rating !== null) counts.rated += 1
    if (item.verdict === 'keep' || item.verdict === 'pick') counts.keep += 1
    else if (item.verdict === 'maybe') counts.maybe += 1
    else if (item.verdict === 'toss') counts.toss += 1
    else if (item.rating === null) counts.unreviewed += 1
  }
  return counts
}

// ---- kinds, glyphs and words ------------------------------------------------------------

const KIND_BY_EXT: Record<string, string> = {}
for (const [kind, exts] of Object.entries({
  audio: 'wav mp3 flac aif aiff ogg oga opus m4a aac caf wma',
  image: 'png jpg jpeg webp gif heic heif bmp tif tiff avif',
  video: 'mp4 mov m4v mkv webm avi mpg mpeg',
  svg: 'svg',
  pdf: 'pdf',
  document: 'doc docx xls xlsx ppt pptx rtf rtfd pages key numbers odt ods odp epub',
  text: 'txt md markdown rst log csv tsv json yaml yml toml ini cfg conf xml html htm css js ts tsx jsx py sh rs go c h cpp scd tex',
})) {
  for (const ext of exts.split(' ')) KIND_BY_EXT[ext] = kind
}

/** The kind a file name suggests, for the glyph and the card before a preview says better. */
export function guessKind(where: string, isUrl: boolean): string {
  if (isUrl) return 'link'
  const dot = where.lastIndexOf('.')
  const slash = where.lastIndexOf('/')
  if (dot <= slash + 1) return 'unknown'
  return KIND_BY_EXT[where.slice(dot + 1).toLowerCase()] ?? 'unknown'
}

const GLYPHS: Record<string, string> = {
  audio: '♪',
  image: '▣',
  video: '▶',
  svg: '◇',
  pdf: '▤',
  document: '▤',
  text: '≡',
  link: '↗',
}

export function kindGlyph(kind: string): string {
  return GLYPHS[kind] ?? '·'
}

const REASONS: Record<string, string> = {
  missing: 'the file is not there',
  unreadable: 'the file could not be read',
  unsupported: 'no preview for this kind of file',
  budget: 'the preview is too big for this view',
  timeout: 'the preview took too long',
  unavailable: 'the preview could not be made',
}

/** A card's reason in words; an unknown reason (a newer CLI) reads as the generic one. */
export function reasonText(reason: string | null): string {
  return reason === null ? REASONS.unavailable! : (REASONS[reason] ?? REASONS.unavailable!)
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${Math.round(n)} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function formatDuration(seconds: number): string {
  if (seconds < 10) return `${seconds.toFixed(2)} s`
  if (seconds < 60) return `${seconds.toFixed(1)} s`
  const m = Math.floor(seconds / 60)
  return `${m}:${String(Math.round(seconds - m * 60)).padStart(2, '0')}`
}

/**
 * The preview's numbers as one dim line: duration, rate, channels, loudness, size, dimensions.
 * `full` adds the detail the focus view has room for.
 */
export function formatMeta(meta: Readonly<Record<string, number>>, full: boolean): string {
  const bits: string[] = []
  const num = (k: string): number | undefined => (typeof meta[k] === 'number' && Number.isFinite(meta[k]) ? meta[k] : undefined)
  const duration = num('duration')
  if (duration !== undefined) bits.push(formatDuration(duration))
  const width = num('width')
  const height = num('height')
  if (width !== undefined && height !== undefined) bits.push(`${width}×${height}`)
  const rate = num('sampleRate')
  if (rate !== undefined && full) bits.push(`${(rate / 1000).toFixed(rate % 1000 === 0 ? 0 : 1)} kHz`)
  const channels = num('channels')
  if (channels !== undefined && full) bits.push(channels === 1 ? 'mono' : channels === 2 ? 'stereo' : `${channels} ch`)
  const lufs = num('lufs')
  if (lufs !== undefined) bits.push(`${lufs.toFixed(1)} LUFS`)
  const peak = num('peakDb')
  if (peak !== undefined && full) bits.push(`peak ${peak.toFixed(1)} dB`)
  const fps = num('fps')
  if (fps !== undefined && full) bits.push(`${fps} fps`)
  const size = num('size')
  if (size !== undefined) bits.push(formatBytes(size))
  return bits.join(' · ')
}

// ---- canvas-preview ------------------------------------------------------------------------

const TIERS = ['rich', 'reduced', 'card'] as const

/**
 * A text file's own markdown, made inert before it is drawn: images (which a renderer may fetch from anywhere,
 * telling the host the file was looked at) become their alt text, and raw HTML tags are dropped.
 */
export function safeMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_all, alt: string) => (alt.trim() === '' ? '[image]' : `[image: ${alt}]`))
    .replace(/!\[([^\]]*)\]\[[^\]]*\]/g, (_all, alt: string) => (alt.trim() === '' ? '[image]' : `[image: ${alt}]`))
    .replace(/<\/?[A-Za-z!][^>\n]*>/g, '')
}

/** Whether `source` opens like an SVG document. */
function isSvgSource(source: string): boolean {
  return /^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/.test(source.slice(0, 2000))
}

/**
 * `canvas-preview --json` output, reduced to what is drawn. `meta` keeps numbers only (container
 * tags are attacker-controlled text and never get here), an Svg must look like one, a clip is a path.
 */
export function parsePreview(stdout: string): PreviewData | null {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!isObject(raw) || !TIERS.includes(raw.tier as (typeof TIERS)[number])) return null
  const meta: Record<string, number> = {}
  if (isObject(raw.meta)) {
    for (const [k, v] of Object.entries(raw.meta)) {
      if (typeof v === 'number' && Number.isFinite(v) && /^[A-Za-z]{1,16}$/.test(k)) meta[k] = v
    }
  }
  const svg = typeof raw.svg === 'string' && isSvgSource(raw.svg) ? raw.svg : null
  const markdown = typeof raw.markdown === 'string' && raw.markdown.trim() !== '' ? safeMarkdown(raw.markdown.slice(0, MAX_MARKDOWN)) : null
  const clip = typeof raw.clip === 'string' && raw.clip.startsWith('/') ? raw.clip : null
  return {
    kind: typeof raw.kind === 'string' ? oneLine(raw.kind, 20) : 'unknown',
    mime: typeof raw.mime === 'string' ? oneLine(raw.mime, 80) : '',
    label: typeof raw.label === 'string' ? oneLine(raw.label, 200) : '',
    meta,
    svg,
    clip,
    markdown,
    tier: raw.tier as PreviewData['tier'],
    reason: typeof raw.reason === 'string' ? oneLine(raw.reason, 20) : null,
  }
}

/**
 * What `open` is asked to do with a file, by kind: media and documents open in their app; text and
 * SVG open in a text editor (never in anything that could run them); anything else is only revealed.
 * The set's paths can come from the model, so a path never reaches `open` plain unless its kind is safe.
 */
export function openArgv(kind: string, where: string, isUrl: boolean): string[] {
  if (isUrl) return ['open', where]
  switch (kind) {
    case 'audio':
    case 'image':
    case 'video':
    case 'pdf':
    case 'document':
      return ['open', where]
    case 'text':
    case 'svg':
      return ['open', '-t', where]
    default:
      return ['open', '-R', where]
  }
}

// ---- canvas-set -----------------------------------------------------------------------------

export type MarkResult = {
  id: string
  verdict: Verdict | null
  rating: number | null
  changed: boolean
  updatedAfterHandoff: boolean
}

export function parseMarkResult(stdout: string): MarkResult | null {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!isObject(raw) || typeof raw.id !== 'string' || typeof raw.changed !== 'boolean') return null
  return {
    id: raw.id,
    verdict: VERDICTS.includes(raw.verdict as Verdict) ? (raw.verdict as Verdict) : null,
    rating: typeof raw.rating === 'number' ? raw.rating : null,
    changed: raw.changed,
    updatedAfterHandoff: raw.updatedAfterHandoff === true,
  }
}

export type SummaryEntry = { label: string; path: string; rating?: number }

/** `canvas-set summary --json`: the only thing a hand-off to Claude is built from. */
export type Summary = {
  file: string
  title: string
  mode: MediaMode
  total: number
  counts: { keep: number; maybe: number; toss: number; notReviewed: number; rated: number }
  kept: SummaryEntry[]
  rated: SummaryEntry[]
  isHandedOff: boolean
}

function entries(raw: unknown, withRating: boolean): SummaryEntry[] | null {
  if (!Array.isArray(raw)) return null
  const out: SummaryEntry[] = []
  for (const one of raw) {
    if (!isObject(one) || typeof one.label !== 'string' || typeof one.path !== 'string') return null
    const entry: SummaryEntry = { label: one.label, path: one.path }
    if (withRating) {
      if (typeof one.rating !== 'number') return null
      entry.rating = one.rating
    }
    out.push(entry)
  }
  return out
}

export function parseSummary(stdout: string): Summary | null {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!isObject(raw) || typeof raw.file !== 'string' || typeof raw.title !== 'string' || !MODES.includes(raw.mode as MediaMode)) return null
  const c = raw.counts
  if (!isObject(c)) return null
  const n = (k: string): number | null => (typeof c[k] === 'number' ? (c[k] as number) : null)
  const [keep, maybe, toss, notReviewed, rated] = [n('keep'), n('maybe'), n('toss'), n('notReviewed'), n('rated')]
  if (keep === null || maybe === null || toss === null || notReviewed === null) return null
  const kept = entries(raw.kept, false)
  const ratedEntries = entries(raw.rated, true)
  if (!kept || !ratedEntries) return null
  return {
    file: raw.file,
    title: raw.title,
    mode: raw.mode as MediaMode,
    total: typeof raw.total === 'number' ? raw.total : kept.length,
    counts: { keep, maybe, toss, notReviewed, rated: rated ?? 0 },
    kept,
    rated: ratedEntries,
    isHandedOff: isObject(raw.handoff),
  }
}

/** Most kept or rated items a hand-off lists; the rest are named in a count and live in the set file. */
export const HANDOFF_LIST_MAX = 40

/**
 * The prompt a finished curation sends:
 * `Curated <title> (<mode>): kept 3, maybe 1, tossed 4, not reviewed 2. Kept: "<label>" <path>; ... Set file: <path>`.
 * Titles and labels are cleaned and cut again here, so the text is safe whatever the CLI handed over.
 */
export function handoffText(s: Summary): string {
  const pickMode = s.mode === 'pick-one' || s.mode === 'pick-many'
  const keptWord = pickMode ? 'picked' : 'kept'
  const c = s.counts
  const parts: string[] = []
  if (s.mode === 'rate') {
    parts.push(`rated ${c.rated}`)
    if (c.keep) parts.push(`${keptWord} ${c.keep}`)
    if (c.maybe) parts.push(`maybe ${c.maybe}`)
    if (c.toss) parts.push(`tossed ${c.toss}`)
  } else {
    parts.push(`${keptWord} ${c.keep}`, `maybe ${c.maybe}`, `tossed ${c.toss}`)
  }
  parts.push(`not reviewed ${c.notReviewed}`)

  const listed = s.mode === 'rate' ? s.rated : s.kept
  const heading = s.mode === 'rate' ? 'Rated' : pickMode ? 'Picked' : 'Kept'
  const shown = listed.slice(0, HANDOFF_LIST_MAX).map(e => {
    const label = e.label.startsWith('"') ? quoteLabel(e.label.slice(1, -1)) : quoteLabel(e.label)
    const rating = e.rating === undefined ? '' : ` ${e.rating}/5`
    return `${label}${rating} ${oneLine(e.path, 1000)}`
  })
  const more = listed.length > shown.length ? ` (and ${listed.length - shown.length} more in the set file)` : ''
  const list = shown.length > 0 ? ` ${heading}: ${shown.join('; ')}${more}.` : ''
  return `Curated ${oneLine(s.title, LABEL_MAX)} (${s.mode}): ${parts.join(', ')}.${list} Set file: ${oneLine(s.file, 1000)}`
}

// ---- the curate tool's input ------------------------------------------------------------------

export type CurateRequest =
  | { kind: 'set'; set: string }
  | { kind: 'items'; items: string[]; title: string; mode: MediaMode }

export const MAX_CURATE_ITEMS = 500
export const MAX_PATH = 1000

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

/** Validates a `curate` call into a request; the error is written for the model. */
export function parseCurate(input: unknown): Parsed<CurateRequest> {
  if (!isObject(input)) return { ok: false, error: 'expected an object { set } or { items, title?, mode? }' }
  const hasSet = input.set !== undefined && input.set !== null
  const hasItems = input.items !== undefined && input.items !== null
  if (hasSet === hasItems) return { ok: false, error: 'give exactly one of "set" (a *.curate.json path) or "items" (paths to curate)' }

  if (hasSet) {
    if (typeof input.set !== 'string' || HAS_CONTROL.test(input.set) || input.set.length > MAX_PATH) {
      return { ok: false, error: 'set: expected one path of at most 1000 characters' }
    }
    if (!input.set.startsWith('/')) return { ok: false, error: 'set: must be an absolute path to a *.curate.json file' }
    return { ok: true, value: { kind: 'set', set: input.set } }
  }

  const raw = input.items
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'items: expected a non-empty array of paths' }
  if (raw.length > MAX_CURATE_ITEMS) return { ok: false, error: `items: ${raw.length} entries, the limit is ${MAX_CURATE_ITEMS}` }
  const items: string[] = []
  for (const [i, one] of raw.entries()) {
    if (typeof one !== 'string' || one === '' || one.length > MAX_PATH || HAS_CONTROL.test(one)) {
      return { ok: false, error: `items[${i}]: expected one path of at most ${MAX_PATH} characters` }
    }
    if (!one.startsWith('/') && !/^https?:\/\/\S+$/i.test(one)) return { ok: false, error: `items[${i}]: must be an absolute path or an http(s) URL` }
    items.push(one)
  }

  let title = 'Curate'
  if (input.title !== undefined && input.title !== null) {
    if (typeof input.title !== 'string') return { ok: false, error: 'title: expected a string' }
    title = oneLine(input.title, 100)
    if (title === '') return { ok: false, error: 'title: must not be empty' }
  }
  let mode: MediaMode = 'triage'
  if (input.mode !== undefined && input.mode !== null) {
    if (!MODES.includes(input.mode as MediaMode)) return { ok: false, error: `mode: expected ${MODES.join(', ')}` }
    mode = input.mode as MediaMode
  }
  return { ok: true, value: { kind: 'items', items, title, mode } }
}

/** `<slug>-<UTC timestamp>.curate.json`: the name an inline set is written under. */
export function inlineSetName(title: string, nowMs: number): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '')
  const stamp = new Date(nowMs).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')
  return `${slug === '' ? 'set' : slug}-${stamp}.curate.json`
}
