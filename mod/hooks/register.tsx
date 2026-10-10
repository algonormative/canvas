import type { Register } from 'claude-code'

import { registerCanvas } from './canvas'
import { registerProbe } from './probe'

// The hooks module the manifest names. Each feature lives in its own file and
// registers its hooks here. The C1 render probe stays until its answers are
// recorded in the design doc.
export const register: Register = (on, options) => {
  registerProbe(on)
  registerCanvas(on, options)
}
