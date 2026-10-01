// Computes real shots with the same engine the browsers use, for the
// end-to-end harness: prints [{shot, result}] as JSON.
import '../../static/pool-engine.js'
const E = globalThis.PoolEngine
const seed = process.argv[2]
let state = E.initialState(seed)
const out = []
const shots = [{dx: -0.9991, dy: 0.0424, power: 100, place: null}, {dx: 0.37, dy: -0.92, power: 61.5, place: null}]
for (const shot of shots) {
  const result = E.runShot(state, shot)
  out.push({shot, result})
  state = result
}
console.log(JSON.stringify(out))
