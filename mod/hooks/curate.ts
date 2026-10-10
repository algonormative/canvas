import type { PendingHandoff, PreviewEntry, SetRecord, Verdict } from '../types'
import {
  guessKind,
  handoffText,
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
  stat(path: string): Promise<{ mtimeMs: number; realPath?: string }>
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
const playing = new Map<string, { id: string; stop: AbortController }>()

export const previewId = (key: string, itemId: string, budget: number): string => `${key}|${itemId}|${budget}`

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
      record: { path: real, data, mtimeMs: stat.mtimeMs, isStale: false, cursor: 0, isFocus: false, playing: null, learned: {} },
    }
  } catch {
    return { ok: false, error: 'the set file could not be read' }
  }
}

/** Stores a freshly opened record; one already open keeps its cursor, focus and what it learned. */
export async function putSet(host: Host, key: string, record: SetRecord): Promise<void> {
  await host.updateSet(key, prev =>
    prev
      ? { ...record, cursor: clamp(prev.cursor, record.data.items.length), isFocus: prev.isFocus, learned: prev.learned }
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

export type Want = { itemId: string; where: string; budget: number }

/** Previews for items the drawing found missing: queued, newest request first, four at a time. */
export function fetchPreviews(host: Host, key: string, wants: readonly Want[]): void {
  const jobs: (() => Promise<void>)[] = []
  for (const want of wants) {
    const id = previewId(key, want.itemId, want.budget)
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
    if (await host.getPreview(id)) return
    let entry: PreviewEntry = { preview: null }
    try {
      const out = await cli(host, 'canvas-preview', [want.where, '--budget', String(want.budget), '--json'])
      if (out.exitCode === 0) entry = { preview: parsePreview(out.stdout) }
      else host.debug(`canvas-preview exited ${out.exitCode}: ${failure(out.stderr)}`)
    } catch {
      host.debug('canvas-preview could not be run')
    }
    await storePreview(host, id, entry)
    const preview = entry.preview
    if (preview) {
      const learned = { kind: preview.kind, clip: preview.clip }
      await host.updateSet(key, r => (r ? { ...r, learned: { ...r.learned, [want.itemId]: learned } } : r))
    }
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
      const kind = record.learned[item.id]?.kind ?? guessKind(item.where, item.isUrl)
      const out = await host.run(openArgv(kind, item.where, item.isUrl), 15_000)
      if (out.exitCode !== 0) host.toast('Could not open that.')
      return
    }
    case 'done':
      await sendResult(host, key, 'done')
      return
  }
}

async function mark(host: Host, key: string, record: SetRecord, id: string, flags: string[], sendsOnPick: boolean): Promise<void> {
  const out = await cli(host, 'canvas-set', ['mark', record.path, id, ...flags, '--json'])
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
  await reloadSet(host, key) // the drawing shows what is on disk
  if (result.updatedAfterHandoff) host.toast('Updated after the result was sent: tell Claude.')
  else if (sendsOnPick) await sendResult(host, key, 'pick')
}

// ---- playback -----------------------------------------------------------------------------------------

function stopPlayback(key: string): void {
  playing.get(key)?.stop.abort()
}

async function play(host: Host, key: string, record: SetRecord): Promise<void> {
  const item = record.data.items[record.cursor]
  if (!item) return
  const current = playing.get(key)
  if (current) {
    current.stop.abort()
    if (current.id === item.id) return // p again stops it
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
  playing.set(key, { id: item.id, stop })
  try {
    const base64 = await host.readBase64(learned.clip)
    if (stop.signal.aborted) return
    await host.updateSet(key, r => (r ? { ...r, playing: item.id } : r))
    await host.play(base64, stop.signal)
  } catch (error) {
    // The engine prefixes a refusal with where it came from ("canvas: $.audio.play: ...").
    const reason = (error instanceof Error ? error.message : String(error)).replace(/^[\w-]+: \$\.[\w.]+:\s*/, '')
    host.toast(`Could not play that: ${oneLine(reason, 120)}`)
  } finally {
    if (playing.get(key)?.stop === stop) playing.delete(key)
    await host.updateSet(key, r => (r && r.playing === item.id ? { ...r, playing: null } : r))
  }
}

/** Stops whatever plays for this set (a pane closing, say). */
export function stopSet(key: string): void {
  stopPlayback(key)
}

// ---- handing the result to Claude --------------------------------------------------------------------------

export type Trigger = 'pick' | 'done'

/**
 * Tells Claude what was curated, once. The summary is read fresh from the file (never from state);
 * an empty prompt box takes it as a prompt, a draft gets it appended and Nick sends; a box that
 * will not take it leaves it for the next prompt to carry. Only then is the hand-off stamped, and a
 * stamp already there ends the matter: Done is refused, a second pick is only a file update.
 */
export async function sendResult(host: Host, key: string, trigger: Trigger): Promise<void> {
  if (sending.has(key)) {
    if (trigger === 'done') host.toast('Already sending: one moment.')
    return
  }
  sending.add(key)
  try {
    const record = await host.getSet(key)
    if (!record) return
    const out = await cli(host, 'canvas-set', ['summary', record.path, '--json'])
    const summary = out.exitCode === 0 ? parseSummary(out.stdout) : null
    if (!summary) {
      host.toast('Could not read the set file to send it.')
      host.debug(`canvas-set summary failed: ${failure(out.stderr)}`)
      return
    }
    if (summary.isHandedOff) {
      if (trigger === 'done') host.toast('Already sent to Claude: nothing more to send.')
      return
    }

    const text = handoffText(summary)
    const draft = await host.promptText()
    let via: 'submit' | 'fill'
    if (draft.trim() === '') {
      try {
        await host.submit(text)
      } catch {
        host.toast('Could not send the result to Claude. Press Done again.')
        return
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

    const stamp = await cli(host, 'canvas-set', ['handoff', record.path, '--via', via])
    if (stamp.exitCode !== 0 && stamp.exitCode !== 3) host.debug(`canvas-set handoff failed: ${failure(stamp.stderr)}`)
    await reloadSet(host, key)
  } finally {
    sending.delete(key)
  }
}

/** A module reload drops the clip that was playing but not the record saying so: clear it. */
export async function clearPlaying(host: Host, keys: readonly string[]): Promise<void> {
  for (const key of keys) {
    await host.updateSet(key, r => (r && r.playing !== null ? { ...r, playing: null } : r))
  }
}
