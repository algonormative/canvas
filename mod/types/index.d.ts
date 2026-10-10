export type ProbePage = 'image' | 'size' | 'interactive'

declare module 'claude-code' {
  interface PluginState {
    canvas: {
      probePage: ProbePage
      probeSize: number
    }
  }
}
