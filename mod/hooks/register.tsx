import type { Register } from 'claude-code'

import { registerCanvas } from './canvas'

// The hooks module the manifest names. Each feature lives in its own file and
// registers its hooks here.
export const register: Register = (on, options) => {
  registerCanvas(on, options)
}
