import type { PendingHandoff, PreviewData, PreviewEntry, SetRecord, Verdict } from '../types'
import {
  handoffText,
  isRunnablePath,
  keyOf,
  oneLine,
  openArgv,
  parseMarkResult,
  parsePreview,
  parseSetFile,
  parseSummary,
} from './setmodel'

// The curate panel's behaviour, without `$`: opening and reloading a set, fetching previews
// (at most four at a time), writing a verdict, playing a clip, and handing the result to
// Claude. The engine only follows `$` inside the hooks file that declares a hook, so every
// effect here goes through `Host`, a bag of closures canvas.tsx builds over its own `$`.
// All media work is the CLIs' (canvas-preview, canvas-set); this file only routes.

export type RunResult = { exitCode: number; stdout: string; stderr: string }

export type Host = {
  // state: the readers subscribe a drawing that is in progress
  getSet(key: string): Promise<SetRecord | null>
  updateSet(key: string, fn: (record: SetRecord | null) => SetRecord | null): Promise<void>
  getPreview(id: string): Promise<PreviewEntry | null>
  setPreview(id: string, entry: PreviewEntry | null): Promise<void>
  updatePreviewIndex(fn: (list: { id: string; size: number }[]) => { id: string; size: number }[]): Promise<void>
  updatePending(fn: (list: PendingHandoff[]) => PendingHandoff[]): Promise<void>
  // the host
  home(): Promise<string | undefined>
  run(argv: string[], timeoutMs: number): Promise<RunResult>
  /** `$.fs.stat` with `resolve: true`; rejects for a path that is not there. */
  stat(path: string): Promise<{ mtimeMs: number; size: number; kind: 'file' | 'dir' | 'other'; realPath?: string }>
  /** The clock, in milliseconds since the epoch. */
  now(): Promise<number>
  readText(path: string): Promise<string>
  readBase64(path: string): Promise<string>
  play(base64: string, signal: AbortSignal): Promise<void>
  /** Runs `fn` on a timer: work started while a drawing is in progress must not write state before it ends. */
  later(ms: number, fn: () => void): void
  toast(text: string): void
  debug(text: string): void
  /** The prompt box as it stands. */
  promptText(): Promise<string>
  submit(text: string): Promise<void>
  /** Appends to the draft; false when the box would not take it. */
  fill(text: string): Promise<boolean>
}

export const SET_SUFFIX = '.curate.json'
const CLI_TIMEOUT_MS = 60_000
const MAX_CONCURRENT_PREVIEWS = 4
/** Characters of preview kept in $.state before the oldest is dropped (a page draws at most 240k). */
const PREVIEW_CACHE_CHARS = 1_500_000
const PREVIEW_CACHE_ENTRIES = 80
/** A spawn that fails faster than this was not found, rather than slow. */
const SPAWN_FAILURE_MS = 2_000
/** A preview that failed is tried again once it is this old (the next time the item is drawn). */
export const FAILED_PREVIEW_TTL_MS = 30_000
/** Waits before each retry of a hand-off stamp that could not be written; three retries in all. */
/** How often an open set's file is looked at for an edit made outside the pane. */
export const SET_POLL_MS = 3_000
const STAMP_RETRY_MS = [2_000, 6_000, 20_000] as const

export type MediaAction =
  | { t: 'move'; delta: number }
  | { t: 'goto'; index: number }
  | { t: 'verdict'; verdict: Verdict | 'clear'; id?: string }
  | { t: 'rate'; rating: number; id?: string }
  | { t: 'play' }
  | { t: 'open' }
  | { t: 'focus' }
  | { t: 'done' }

// Module variables hold only what dies with the module anyway: in-flight guards and the clip
// that is playing. A reload drops them; everything the person sees lives in $.state.
const inflight = new Set<string>()
const queue: (() => Promise<void>)[] = []
let active = 0
const reloading = new Set<string>()
const again = new Set<string>()
const sending = new Set<string>()
/** Sets with a mark that landed while their result was being sent. */
const dirty = new Set<string>()
const stamping = new Set<string>()
/** Preview ids of the items on the page each panel of a set is drawing now (set key, then panel index). */
const visible = new Map<string, Map<number, Set<string>>>()
/** Sets whose file is being polled for outside edits. */
const watching = new Set<string>()
/** The one clip that plays, in whichever set: starting another stops it. */
let player: { key: string; id: string; stop: AbortController } | null = null

/**
 * A preview's place in the cache. `stamp` is what the file was when it was looked at (see `statStamp`), so a
 * file that changed asks for a new preview instead of showing the old one.
 */
export const previewId = (key: string, itemId: string, budget: number, stamp: string): string =>
  `${key}|${itemId}|${budget}|${stamp}`

/** `<mtime>:<size>` of a file, or `missing` when it has no stat. */
export async function statStamp(host: Host, where: string): Promise<string> {
  try {
    const found = await host.stat(where)
    return `${found.mtimeMs}:${found.size}`
  } catch {
    return 'missing'
  }
}

/** Whether a cached entry may be drawn now: a failure is only good for a while, a preview for as long as its file is the same. */
export function isUsable(entry: PreviewEntry | null, now: number): entry is PreviewEntry {
  if (!entry) return false
  return entry.preview !== null || (entry.at !== undefined && now - entry.at < FAILED_PREVIEW_TTL_MS)
}

/** The key a set goes by in $.state: its real path, so a link to a set and the set itself are one set. */
export async function setKeyOf(host: Host, path: string): Promise<string> {
  try {
    return keyOf((await host.stat(path)).realPath ?? path)
  } catch {
    return keyOf(path)
  }
}

const clamp = (n: number, count: number): number => Math.min(Math.max(0, n), Math.max(0, count - 1))

const failure = (stderr: string): string => oneLine(stderr.split('\n').find(line => line.trim() !== '') ?? '', 300)

// ---- running the CLIs ----------------------------------------------------------------

/**
 * Runs a canvas CLI by its bare name. A desktop session may not carry ~/.local/bin on its PATH:
 * a spawn that fails at once is tried again by the absolute path, where `uv tool` puts it.
 */
export async function cli(host: Host, name: string, args: string[], timeoutMs: number = CLI_TIMEOUT_MS): Promise<RunResult> {
  const started = Date.now()
  try {
    return await host.run([name, ...args], timeoutMs)
  } catch (first) {
    const home = await host.home()
    if (!home || Date.now() - started > SPAWN_FAILURE_MS) throw first
    return host.run([`${home.replace(/\/$/, '')}/.local/bin/${name}`, ...args], timeoutMs)
  }
}

// ---- opening and reloading a set ----------------------------------------------------------

export type Opened = { ok: true; record: SetRecord } | { ok: false; error: string }

/**
 * Takes a set file: absolute, named `*.curate.json` (after links are followed), passing
 * `canvas-set validate`, and readable. Returns a fresh record; the caller decides whether it
 * replaces an open one. The mod writes only to files that pass here.
 */
export async function openSetFile(host: Host, rawPath: string): Promise<Opened> {
  if (!rawPath.startsWith('/')) return { ok: false, error: 'the set path must be absolute' }
  if (!rawPath.endsWith(SET_SUFFIX)) return { ok: false, error: `a set file is named *${SET_SUFFIX}` }
  let real: string
  try {
    real = (await host.stat(rawPath)).realPath ?? rawPath
  } catch {
    return { ok: false, error: 'there is no such set file' }
  }
  if (!real.endsWith(SET_SUFFIX)) return { ok: false, error: `a set file is named *${SET_SUFFIX}` }

  let checked: RunResult
  try {
    checked = await cli(host, 'canvas-set', ['validate', real])
  } catch {
    return { ok: false, error: 'canvas-set could not be run (is it on the PATH?)' }
  }
  if (checked.exitCode !== 0) return { ok: false, error: `the set file does not validate: ${failure(checked.stderr)}` }

  try {
    const stat = await host.stat(real)
    const data = parseSetFile(await host.readText(real))
    if (!data) return { ok: false, error: 'the set file could not be read' }
    return {
      ok: true,
      record: {
        path: real,
        data,
        mtimeMs: stat.mtimeMs,
        isStale: false,
        cursor: 0,
        isFocus: false,
        playing: null,
        learned: {},
        stampPending: null,
      },
    }
  } catch {
    return { ok: false, error: 'the set file could not be read' }
  }
}

/**
 * Stores a freshly opened record; one already open keeps its cursor, focus, what it learned, the clip
 * it is playing and a hand-off stamp it still owes (opening a set again must not make any of those forget).
 */
export async function putSet(host: Host, key: string, record: SetRecord): Promise<void> {
  await host.updateSet(key, prev =>
    prev
      ? {
          ...record,
          cursor: clamp(prev.cursor, record.data.items.length),
          isFocus: prev.isFocus,
          learned: prev.learned,
          playing: prev.playing,
          stampPending: prev.stampPending ?? null,
        }
      : record,
  )
}

const opening = new Set<string>()

/** A `show` panel's set is not in state (it was lost): open it again from the panel's own path. */
export async function reopenSet(host: Host, key: string, rawPath: string): Promise<void> {
  if (opening.has(key)) return
  opening.add(key)
  try {
    const opened = await openSetFile(host, rawPath)
    if (opened.ok) await putSet(host, key, opened.record)
    else host.toast(`Could not open the set for a media panel: ${opened.error}`)
  } finally {
    opening.delete(key)
  }
}

/**
 * Re-reads the set file into the open record (the cursor stays). One reload runs at a time per set; one asked
 * for while another is reading runs again when that one ends, so a write made after the first read is never missed.
 */
export async function reloadSet(host: Host, key: string): Promise<void> {
  if (reloading.has(key)) {
    again.add(key)
    return
  }
  reloading.add(key)
  try {
    do {
      again.delete(key)
      await readSetInto(host, key)
    } while (again.has(key))
  } finally {
    reloading.delete(key)
    again.delete(key)
  }
}

async function readSetInto(host: Host, key: string): Promise<void> {
  const record = await host.getSet(key)
  if (!record) return
  let mtimeMs: number
  let text: string
  try {
    mtimeMs = (await host.stat(record.path)).mtimeMs
    text = await host.readText(record.path)
  } catch {
    return // the file is gone or unreadable for now: the drawing says so from its own stat
  }
  const data = parseSetFile(text)
  await host.updateSet(key, r =>
    r
      ? {
          ...r,
          data: data ?? r.data,
          isStale: data === null,
          mtimeMs,
          cursor: clamp(r.cursor, (data ?? r.data).items.length),
        }
      : r,
  )
}

// ---- previews ----------------------------------------------------------------------------------

export type Want = { itemId: string; where: string; budget: number; stamp: string }

/** What one panel of a set is drawing now: a queued preview for anything else is dropped before it runs. */
export function setVisible(key: string, panel: number, ids: readonly string[]): void {
  const panels = visible.get(key) ?? new Map<number, Set<string>>()
  panels.set(panel, new Set(ids))
  visible.set(key, panels)
}

function isVisible(key: string, id: string): boolean {
  for (const ids of visible.get(key)?.values() ?? []) if (ids.has(id)) return true
  return false
}

/** Previews for items the drawing found missing: queued, newest request first, four at a time. */
export function fetchPreviews(host: Host, key: string, wants: readonly Want[]): void {
  const jobs: (() => Promise<void>)[] = []
  for (const want of wants) {
    const id = previewId(key, want.itemId, want.budget, want.stamp)
    if (inflight.has(id)) continue
    inflight.add(id)
    jobs.push(() => fetchOne(host, key, id, want))
  }
  queue.splice(0, 0, ...jobs)
  pump()
}

function pump(): void {
  while (active < MAX_CONCURRENT_PREVIEWS) {
    const job = queue.shift()
    if (!job) return
    active += 1
    void job().finally(() => {
      active -= 1
      pump()
    })
  }
}

async function fetchOne(host: Host, key: string, id: string, want: Want): Promise<void> {
  try {
    if (!isVisible(key, id)) return // queued while its page was showing, and the page has moved on
    if (isUsable(await host.getPreview(id), await host.now())) return
    let preview: PreviewData | null = null
    try {
      const out = await cli(host, 'canvas-preview', [want.where, '--budget', String(want.budget), '--json'])
      if (out.exitCode === 0) preview = parsePreview(out.stdout)
      else host.debug(`canvas-preview exited ${out.exitCode}: ${failure(out.stderr)}`)
    } catch {
      host.debug('canvas-preview could not be run')
    }
    // A failure is remembered with its time, and tried again after FAILED_PREVIEW_TTL_MS.
    await storePreview(host, id, preview ? { preview } : { preview: null, at: await host.now() })
    // What the item is and where its clip lives follow the file: a failed look forgets the old answer.
    const learned = preview ? { kind: preview.kind, clip: preview.clip } : null
    await host.updateSet(key, r => {
      if (!r) return r
      const { [want.itemId]: _old, ...rest } = r.learned
      return { ...r, learned: learned ? { ...rest, [want.itemId]: learned } : rest }
    })
  } catch {
    host.debug('a preview could not be stored')
  } finally {
    inflight.delete(id)
  }
}

/** Keeps a result in $.state and drops the oldest ones past the cap, so a long session cannot grow it without bound. */
async function storePreview(host: Host, id: string, entry: PreviewEntry): Promise<void> {
  const size = (entry.preview?.svg?.length ?? 0) + (entry.preview?.markdown?.length ?? 0) + 200
  let evicted: string[] = []
  await host.setPreview(id, entry)
  await host.updatePreviewIndex(list => {
    const next = [...list.filter(one => one.id !== id), { id, size }]
    evicted = []
    let total = next.reduce((sum, one) => sum + one.size, 0)
    while (next.length > 1 && (total > PREVIEW_CACHE_CHARS || next.length > PREVIEW_CACHE_ENTRIES)) {
      const oldest = next.shift()
      if (!oldest) break
      total -= oldest.size
      evicted.push(oldest.id)
    }
    return next
  })
  for (const gone of evicted) await host.setPreview(gone, null)
}

// ---- actions ----------------------------------------------------------------------------------------

export async function runAction(host: Host, key: string, action: MediaAction): Promise<void> {
  try {
    await act(host, key, action)
  } catch {
    host.toast('That did not work. Try again.')
    host.debug(`curate: ${action.t} failed`)
  }
}

async function act(host: Host, key: string, action: MediaAction): Promise<void> {
  const record = await host.getSet(key)
  if (!record) return
  const { items, mode } = record.data

  switch (action.t) {
    case 'move':
    case 'goto': {
      const to = clamp(action.t === 'move' ? record.cursor + action.delta : action.index, items.length)
      if (to !== record.cursor) stopPlayback(key)
      await host.updateSet(key, r => (r ? { ...r, cursor: clamp(to, r.data.items.length) } : r))
      return
    }
    case 'focus':
      await host.updateSet(key, r => (r ? { ...r, isFocus: !r.isFocus } : r))
      return
    case 'verdict':
    case 'rate': {
      const index = action.id === undefined ? record.cursor : items.findIndex(one => one.id === action.id)
      const item = items[index]
      if (!item) return
      if (action.t === 'rate' && mode !== 'rate') {
        host.toast('Ratings are for sets in rate mode.')
        return
      }
      if (index !== record.cursor) {
        stopPlayback(key)
        await host.updateSet(key, r => (r ? { ...r, cursor: clamp(index, r.data.items.length) } : r))
      }
      const pickMode = mode === 'pick-one' || mode === 'pick-many'
      const verdict = action.t === 'verdict' ? (action.verdict === 'keep' && pickMode ? 'pick' : action.verdict) : null
      const flags = action.t === 'rate' ? ['--rating', String(action.rating)] : ['--verdict', verdict as string]
      await mark(host, key, record, item.id, flags, mode === 'pick-one' && verdict === 'pick')
      return
    }
    case 'play':
      await play(host, key, record)
      return
    case 'open': {
      const item = items[record.cursor]
      if (!item) return
      const { argv, isGuarded } = await openCommand(host, item.where, item.isUrl)
      const out = await host.run(argv, 15_000)
      if (out.exitCode !== 0) host.toast('Could not open that.')
      else if (isGuarded) host.toast('Showing it in Finder: it could run as a program, so it is not opened.')
      return
    }
    case 'done':
      if (mode === 'pick-one') {
        host.toast('In a pick-one set the pick sends the result: there is no Done.')
        return
      }
      await sendResult(host, key, 'done')
      return
  }
}

/**
 * How `o` opens an item. The kind comes only from the extension of the item's current path (see openArgv):
 * a preview's sniffed kind, or what the item was when it was first drawn, is not consulted, since the
 * set file can be rewritten under the same id. Before a plain open, the file itself is looked at: one
 * that is not a regular file, whose real path (past any link) names a program, or that has the
 * executable bit, is only revealed. Anything that cannot be checked is only revealed too.
 */
async function openCommand(host: Host, where: string, isLink: boolean): Promise<{ argv: string[]; isGuarded: boolean }> {
  const argv = openArgv(where, isLink)
  if (isLink || argv[1] === '-R') return { argv, isGuarded: false }
  if (await couldRun(host, where)) return { argv: ['open', '-R', where], isGuarded: true }
  return { argv, isGuarded: false }
}

async function couldRun(host: Host, where: string): Promise<boolean> {
  try {
    const found = await host.stat(where)
    if (found.kind !== 'file') return true
    if (found.realPath !== undefined && isRunnablePath(found.realPath)) return true
    // $.fs.stat answers no mode, so the executable bit is asked of test(1), which follows links.
    return (await host.run(['/bin/test', '-x', where], 5_000)).exitCode === 0
  } catch {
    return true
  }
}

async function mark(host: Host, key: string, record: SetRecord, id: string, flags: string[], sendsOnPick: boolean): Promise<void> {
  // The id comes from a file the model may have written: after `--` it cannot be read as an option.
  const out = await cli(host, 'canvas-set', ['mark', record.path, ...flags, '--json', '--', id])
  if (out.exitCode === 3) {
    host.toast('Already sent to Claude: a new pick would not reach it.')
    return
  }
  const result = out.exitCode === 0 ? parseMarkResult(out.stdout) : null
  if (!result) {
    host.toast('Could not save that mark.')
    host.debug(`canvas-set mark failed: ${failure(out.stderr)}`)
    return
  }
  // A change that lands while the result is being sent is told apart from one the send already holds.
  if (result.changed && !result.updatedAfterHandoff && sending.has(key)) dirty.add(key)
  await reloadSet(host, key) // the drawing shows what is on disk
  if (result.updatedAfterHandoff) host.toast('Updated after the result was sent: tell Claude.')
  else if (sendsOnPick) await sendResult(host, key, 'pick')
}

// ---- playback -----------------------------------------------------------------------------------------

/** Stops the clip when it is one of this set's. */
function stopPlayback(key: string): void {
  if (player?.key === key) player.stop.abort()
}

async function play(host: Host, key: string, record: SetRecord): Promise<void> {
  const item = record.data.items[record.cursor]
  if (!item) return
  // One clip at a time across every set: starting this one stops whatever plays, wherever it plays.
  const current = player
  if (current) {
    current.stop.abort()
    if (current.key === key && current.id === item.id) return // p again stops it
  }
  const learned = record.learned[item.id]
  if (!learned) {
    host.toast('The preview is still loading.')
    return
  }
  if (learned.kind !== 'audio' || !learned.clip) {
    host.toast(learned.kind === 'audio' ? 'No clip to play for this one.' : 'Only audio plays here. Press o to open it.')
    return
  }
  const stop = new AbortController()
  const mine = { key, id: item.id, stop }
  player = mine
  try {
    const base64 = await host.readBase64(learned.clip)
    if (stop.signal.aborted) return
    await host.updateSet(key, r => (r ? { ...r, playing: item.id } : r))
    if (stop.signal.aborted) return // stopped while the record was being written: nothing starts
    await host.play(base64, stop.signal)
  } catch (error) {
    // The engine prefixes a refusal with where it came from ("canvas: $.audio.play: ...").
    const reason = (error instanceof Error ? error.message : String(error)).replace(/^[\w-]+: \$\.[\w.]+:\s*/, '')
    host.toast(`Could not play that: ${oneLine(reason, 120)}`)
  } finally {
    if (player === mine) player = null
    await host.updateSet(key, r => (r && r.playing === item.id ? { ...r, playing: null } : r))
  }
}

/**
 * A curate pane closed: its clip stops, its polling ends and its record leaves $.state. A record that still owes a
 * hand-off stamp stays until the retries are done with it.
 */
export async function closeSet(host: Host, key: string): Promise<void> {
  stopPlayback(key)
  visible.delete(key)
  watching.delete(key)
  await host.updateSet(key, r => (r?.stampPending ? r : null))
}

/** Looks at the set file every SET_POLL_MS while its record is in $.state, and reads it again when its mtime moved. */
export function watchSet(host: Host, key: string): void {
  if (watching.has(key)) return
  watching.add(key)
  const tick = async (): Promise<void> => {
    if (!watching.has(key)) return
    try {
      const record = await host.getSet(key)
      if (!record) {
        watching.delete(key)
        return
      }
      const { mtimeMs } = await host.stat(record.path)
      if (mtimeMs !== record.mtimeMs) await reloadSet(host, key)
    } catch {
      // the file is gone for now: the drawing says so; keep looking
    }
    if (watching.has(key)) host.later(SET_POLL_MS, () => void tick())
  }
  host.later(SET_POLL_MS, () => void tick())
}

/** Stops whatever plays for this set (a pane closing, say). */
export function stopSet(key: string): void {
  stopPlayback(key)
}

// ---- handing the result to Claude --------------------------------------------------------------------------

export type Trigger = 'pick' | 'done'

type Via = 'submit' | 'fill'
/** What writing the stamp came to: written, written already by someone, refused (the file changed), or not written. */
type StampOutcome = 'stamped' | 'already' | 'changed' | 'failed'

/** The words that send the person back to the control that sends: pick-one has no Done. */
const sendAgain = (mode: string): string => (mode === 'pick-one' ? 'pick again' : 'press Done again')

/**
 * Tells Claude what was curated. The summary is read fresh from the file (never from state) and carries
 * a digest of the bytes it was made from; an empty prompt box takes it as a prompt, a draft gets it
 * appended and Nick sends; a box that will not take it leaves it for the next prompt to carry. Only then
 * is the hand-off stamped, with that digest: a file that changed while the text was on its way is refused
 * the stamp, and the changed set is summarised and sent once more (once: a second change asks the
 * person to press again). A stamp already there ends the matter: Done is refused, a second pick is only
 * a file update. A stamp that could not be written does not send again; it is retried (see markStampPending).
 */
export async function sendResult(host: Host, key: string, trigger: Trigger): Promise<void> {
  if (sending.has(key)) {
    if (trigger === 'done') host.toast('Already sending: one moment.')
    return
  }
  sending.add(key)
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!(await sendOnce(host, key, trigger, attempt === 0))) return
    }
  } finally {
    sending.delete(key)
    dirty.delete(key)
  }
}

/** One summary, one send, one stamp. True when the file changed under it and another round is due. */
async function sendOnce(host: Host, key: string, trigger: Trigger, isFirst: boolean): Promise<boolean> {
  const record = await host.getSet(key)
  if (!record) return false
  if (record.stampPending) {
    await pressedWhilePending(host, key, record, trigger)
    return false
  }
  const out = await cli(host, 'canvas-set', ['summary', record.path, '--json'])
  const summary = out.exitCode === 0 ? parseSummary(out.stdout) : null
  if (!summary) {
    host.toast('Could not read the set file to send it.')
    host.debug(`canvas-set summary failed: ${failure(out.stderr)}`)
    return false
  }
  dirty.delete(key) // every mark so far is in this summary
  if (summary.isHandedOff) {
    if (trigger === 'done') host.toast('Already sent to Claude: nothing more to send.')
    return false
  }

  const text = handoffText(summary)
  const draft = await host.promptText()
  let via: Via
  if (draft.trim() === '') {
    try {
      await host.submit(text)
    } catch {
      host.toast(`Could not send the result to Claude. ${sendAgain(record.data.mode).replace(/^./, c => c.toUpperCase())}.`)
      return false
    }
    via = 'submit'
    host.toast('Sent the curation result to Claude.')
  } else {
    via = 'fill'
    const filled = await host.fill(`${draft.endsWith('\n') ? '' : '\n\n'}${text}`).catch(() => false)
    if (filled) {
      host.toast('Added the curation result to your draft: send it when ready.')
    } else {
      await host.updatePending(list => [...list.filter(one => one.set !== record.path), { set: record.path, text }])
      host.toast('Your prompt box is busy: the result goes with your next message.')
    }
  }

  // From here the result is out. Nothing below may end in "try again": a second send is a duplicate.
  const outcome = await stamp(host, record.path, via, summary.digest)
  if (outcome === 'failed') {
    await markStampPending(host, key, via, summary.digest)
    return false
  }
  if (outcome === 'changed') {
    if (isFirst) return true // the text that went is stale: summarise the set as it is now and send that
    host.toast(`Set changed while sending — ${sendAgain(record.data.mode)}.`)
    return false
  }
  if (dirty.has(key)) host.toast('Updated after the result was sent: tell Claude.')
  await reloadSet(host, key).catch(() => undefined)
  return false
}

async function stamp(host: Host, path: string, via: Via, digest: string): Promise<StampOutcome> {
  try {
    const out = await cli(host, 'canvas-set', ['handoff', path, '--via', via, '--expect-digest', digest])
    if (out.exitCode === 0) return 'stamped'
    if (out.exitCode === 3) return 'already'
    if (out.exitCode === 4) return 'changed'
    host.debug(`canvas-set handoff failed: ${failure(out.stderr)}`)
  } catch {
    host.debug('canvas-set handoff could not be run')
  }
  return 'failed'
}

/** The result went but the file does not say so: remember that, so nothing sends it again, and keep trying to write it. */
async function markStampPending(host: Host, key: string, via: Via, digest: string): Promise<void> {
  await host.updateSet(key, r => (r ? { ...r, stampPending: { via, digest, retries: 0 } } : r))
  host.toast('Sent; recording it failed, retrying')
  scheduleStampRetry(host, key, STAMP_RETRY_MS[0])
}

function scheduleStampRetry(host: Host, key: string, ms: number): void {
  host.later(ms, () => void retryStamp(host, key).catch(() => undefined))
}

async function retryStamp(host: Host, key: string): Promise<void> {
  if (stamping.has(key)) return // a try is already under way
  const record = await host.getSet(key)
  const pending = record?.stampPending
  if (!record || !pending) return
  stamping.add(key)
  try {
    const clear = () => host.updateSet(key, r => (r ? { ...r, stampPending: null } : r))
    const outcome = await stamp(host, record.path, pending.via, pending.digest)
    if (outcome === 'stamped' || outcome === 'already') {
      await clear()
      await reloadSet(host, key).catch(() => undefined)
      host.toast('Recorded that the result was sent.')
    } else if (outcome === 'changed') {
      // The set moved on after the text went: that text is no longer the set. Free the next send.
      await clear()
      host.toast(`Set changed after it was sent — ${sendAgain(record.data.mode)}.`)
    } else {
      const retries = pending.retries + 1
      await host.updateSet(key, r => (r?.stampPending ? { ...r, stampPending: { ...r.stampPending, retries } } : r))
      const wait = STAMP_RETRY_MS[retries]
      if (wait !== undefined) scheduleStampRetry(host, key, wait)
      else host.toast(`Sent, but recording it failed. ${sendAgain(record.data.mode).replace(/^./, c => c.toUpperCase())} to try recording it again.`)
    }
  } finally {
    stamping.delete(key)
  }
}

/** Done or a pick on a set whose result is out but unstamped: never a second send; after the retries ran out, one more go at the stamp. */
async function pressedWhilePending(host: Host, key: string, record: SetRecord, trigger: Trigger): Promise<void> {
  if (trigger === 'done') host.toast('Already sent to Claude: still recording it.')
  const pending = record.stampPending
  if (pending && pending.retries >= STAMP_RETRY_MS.length) {
    await host.updateSet(key, r => (r?.stampPending ? { ...r, stampPending: { ...r.stampPending, retries: 0 } } : r))
    scheduleStampRetry(host, key, 0)
  }
}

/** A reload drops the retry timers with the module: the sets that still owe a stamp start their retries again. */
export async function resumeStamps(host: Host, keys: readonly string[]): Promise<void> {
  for (const key of keys) {
    const pending = (await host.getSet(key))?.stampPending
    if (pending && pending.retries < STAMP_RETRY_MS.length) scheduleStampRetry(host, key, STAMP_RETRY_MS[pending.retries] ?? 0)
  }
}

/** A module reload drops the clip that was playing but not the record saying so: clear it. */
export async function clearPlaying(host: Host, keys: readonly string[]): Promise<void> {
  for (const key of keys) {
    await host.updateSet(key, r => (r && r.playing !== null ? { ...r, playing: null } : r))
  }
}
