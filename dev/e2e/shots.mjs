// Computes real shots with the same engine the browsers use, for the
// end-to-end harness: prints [{shot, result}] as JSON.
//
// The rack depends on the match id, so a given shot can pot the 8 ball in one
// match and not in another. The harness needs the match still in play after
// these turns, so each turn takes the first of a few shots that does not end it.
import '../../static/pool-engine.js'
const E = globalThis.PoolEngine
const seed = process.argv[2]
let state = E.initialState(seed)
const out = []
const turns = [
  [{dx: -0.9991, dy: 0.0424, power: 100, place: null}, {dx: -1, dy: 0, power: 100, place: null}, {dx: -0.98, dy: 0.199, power: 90, place: null}],
  [{dx: 0.37, dy: -0.92, power: 61.5, place: null}, {dx: 0.6, dy: 0.8, power: 40, place: null}, {dx: -0.8, dy: 0.6, power: 30, place: null}, {dx: 0, dy: 1, power: 20, place: null}]
]
for (const candidates of turns) {
  const played = candidates.map(shot => ({shot, result: E.runShot(state, shot)}))
  const turn = played.find(item => item.result.winner === 0)
  if (!turn) throw new Error('every candidate shot ends the match for seed ' + seed)
  out.push(turn)
  state = turn.result
}
console.log(JSON.stringify(out))
