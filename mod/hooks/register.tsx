import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { ProbePage } from '../types'

// C1 render probe: answers what the desktop surface does with media inside a Pane.
// Removed once the answers are recorded in vault/active/claude-mods/design.md.

const PROBE = 'canvas-probe'
const page = atom({ plugin: 'canvas', key: 'probePage' } as const, 'image' as ProbePage)
const size = atom({ plugin: 'canvas', key: 'probeSize' } as const, 30_000)
const SIZES = [30_000, 60_000, 90_000, 130_000, 200_000]

let jpeg = ''
let tone = ''
let playing: AbortController | undefined

function rectsSvg(chars: number): string {
  const head = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200">'
  const parts = [head]
  let length = head.length + 6
  for (let i = 0; length < chars - 80; i++) {
    const x = (i * 7) % 320
    const y = Math.floor((i * 7) / 320) % 200
    const rect = `<rect x="${x}" y="${y}" width="6" height="6" fill="#${((i * 2654435761) >>> 8).toString(16).padStart(6, '0').slice(0, 6)}"/>`
    parts.push(rect)
    length += rect.length
  }
  parts.push('</svg>')
  return parts.join('')
}

function imageSvg(attr: 'href' | 'xlink:href'): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ' +
    'width="160" height="100" viewBox="0 0 320 200">' +
    `<image ${attr}="data:image/jpeg;base64,${jpeg}" x="0" y="0" width="320" height="200"/></svg>`
  )
}

const TOOLTIP_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60" viewBox="0 0 200 60">' +
  '<style>rect:hover{fill:#e0a030}</style>' +
  '<rect x="0" y="0" width="200" height="60" fill="#3070c0"><title>tooltip works</title></rect>' +
  '<text x="10" y="35" fill="white" font-size="14">hover me</text></svg>'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: PROBE, description: 'Open the canvas render probe pane' })
    const root = $.plugin.root
    jpeg = (await $.fs.read(`${root}/hooks/probe/thumb.jpg`, { as: 'bytes' })).base64
    tone = (await $.fs.read(`${root}/hooks/probe/tone.mp3`, { as: 'bytes' })).base64
    return next(e)
  })

  on('command.run', { command: PROBE }, async $ => {
    await $.ui.open({ id: PROBE, title: 'Canvas probe', focus: true })
    return { text: 'Canvas probe pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PROBE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const current = await read($, page)
    const chars = await read($, size)
    const cols = e.props.bodyColumns
    const go = (p: ProbePage) => () => void update($, page, () => p)

    const nav = (
      <Box flexDirection="row" gap={1}>
        <Button label="Image" hotkey="1" onPress={go('image')} />
        <Button label="Size" hotkey="2" onPress={go('size')} />
        <Button label="Tooltip" hotkey="3" onPress={go('interactive')} />
        <Button
          label="Play tone"
          hotkey="p"
          onPress={() => {
            playing?.abort()
            playing = new AbortController()
            $.audio
              .play({ base64: tone, mime: 'audio/mpeg' }, { signal: playing.signal })
              .then(() => $.ui.toast('canvas probe: tone finished'))
              .catch(err => $.ui.toast(`canvas probe: play failed: ${String(err)}`))
          }}
        />
      </Box>
    )

    if (!('Svg' in els)) {
      return (
        <Box flexDirection="column">
          {nav}
          <Text>Surface {e.surface} has no Svg; bodyColumns {cols}.</Text>
        </Box>
      )
    }
    const { Svg } = els

    let body
    if (current === 'image') {
      body = (
        <Box flexDirection="column">
          <Text>A: data-URI JPEG via href. B: via xlink:href. C: vector only (control).</Text>
          <Text dimColor>A</Text>
          <Svg source={imageSvg('href')} alt="probe A: data-URI href" width={160} height={100} />
          <Text dimColor>B</Text>
          <Svg source={imageSvg('xlink:href')} alt="probe B: data-URI xlink" width={160} height={100} />
          <Text dimColor>C</Text>
          <Svg source={rectsSvg(4_000)} alt="probe C: vector control" width={160} height={100} />
        </Box>
      )
    } else if (current === 'size') {
      const source = rectsSvg(chars)
      body = (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            {SIZES.map((n, i) => (
              <Button
                key={`size-${n}`}
                label={`${n / 1000}k`}
                hotkey={String.fromCharCode(97 + i)}
                onPress={() => void update($, size, () => n)}
              />
            ))}
          </Box>
          <Text>
            One Svg of {source.length} chars, then two of {Math.round(source.length / 2)} (total ≈ same).
          </Text>
          <Svg source={source} alt={`probe single ${source.length}`} width={320} height={200} />
          <Svg source={rectsSvg(chars / 2)} alt="probe half one" width={160} height={100} />
          <Svg source={rectsSvg(chars / 2)} alt="probe half two" width={160} height={100} />
        </Box>
      )
    } else {
      body = (
        <Box flexDirection="column">
          <Text>Hover the blue box: it should turn orange and show a tooltip.</Text>
          <Svg source={TOOLTIP_SVG} alt="probe tooltip" width={200} height={60} isInteractive />
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {nav}
        <Text dimColor>
          surface {e.surface} · bodyColumns {cols} · page {current}
        </Text>
        {body}
      </Box>
    )
  })
}
