import assert from 'node:assert/strict'
import {test} from 'node:test'
import '../../static/pool-engine.js'

const E = globalThis.PoolEngine
const R = E.BALL_RADIUS

// A table with only the named balls on it: {0: [x, y], 3: [x, y], ...}.
function tableWith(balls, overrides = {}) {
  const state = E.initialState('layout')
  state.balls = state.balls.map((_, number) => balls[number] || null)
  return {...state, breaking: false, ...overrides}
}

// A finished simulation in which the balls ended where they started, except
// for those that were potted.
function outcome(state, {first = null, potted = []}) {
  const balls = state.balls.map((at, id) => ({id, x: at ? at[0] : 0, y: at ? at[1] : 0, vx: 0, vy: 0, on: !!at && !potted.includes(id)}))
  return E.finishShot(state, {balls, first, potted, done: true})
}

const everyBall = () => {
  const balls = {0: [750, 250], 8: [500, 250]}
  for (let n = 1; n <= 7; n += 1) balls[n] = [100 + n * 60, 100]
  for (let n = 9; n <= 15; n += 1) balls[n] = [100 + (n - 8) * 60, 400]
  return balls
}

// ── Rack ────────────────────────────────────────────────────────────────────

test('the rack is legal, tight and free of overlaps', () => {
  for (const seed of ['m_1', 'm_2', 'another match', '']) {
    const {balls} = E.initialState(seed)
    assert.deepEqual(balls[0], [750, 250])
    assert.equal(balls.filter(Boolean).length, 16)
    // The 8 sits in the middle of the third row.
    const rowStep = (R * 2 + 0.4) * (Math.sqrt(3) / 2)
    assert.ok(Math.abs(balls[8][0] - (250 - 2 * rowStep)) < 0.001)
    assert.equal(balls[8][1], 250)
    // One solid and one stripe in the back corners.
    const backX = Math.min(...balls.slice(1).map(at => at[0]))
    const back = balls.map((at, n) => ({n, at})).filter(item => item.n > 0 && Math.abs(item.at[0] - backX) < 0.001)
    back.sort((a, b) => a.at[1] - b.at[1])
    assert.equal(back.length, 5)
    assert.deepEqual([E.ballKind(back[0].n), E.ballKind(back[4].n)].sort(), [E.SOLIDS, E.STRIPES])
    for (let a = 0; a < 16; a += 1) {
      for (let b = a + 1; b < 16; b += 1) {
        const gap = Math.hypot(balls[a][0] - balls[b][0], balls[a][1] - balls[b][1])
        assert.ok(gap >= R * 2, 'balls ' + a + ' and ' + b + ' overlap')
      }
    }
  }
})

test('the rack depends only on the seed', () => {
  assert.deepEqual(E.initialState('m_abc'), E.initialState('m_abc'))
  const orders = new Set(['a', 'b', 'c', 'd', 'e', 'f'].map(seed => JSON.stringify(E.initialState(seed).balls)))
  assert.ok(orders.size > 1)
})

// ── Determinism ─────────────────────────────────────────────────────────────

test('the same shot on the same table always gives the same table', () => {
  const state = E.initialState('m_determinism')
  const shot = {dx: -0.999, dy: 0.0447, power: 100, place: null}
  const once = JSON.stringify(E.runShot(state, shot))
  assert.equal(JSON.stringify(E.runShot(state, shot)), once)
  // A shot that went through JSON, as it does on its way to the opponent.
  assert.equal(JSON.stringify(E.runShot(JSON.parse(JSON.stringify(state)), JSON.parse(JSON.stringify(shot)))), once)
})

test('how a shot is animated does not change where the balls stop', () => {
  const state = E.initialState('m_frames')
  const shot = {dx: -1, dy: 0.013, power: 93, place: null}
  const expected = JSON.stringify(E.runShot(state, shot))
  // Different "frame rates": a different number of steps per frame each time.
  for (const pattern of [[1], [4], [2, 7, 1, 13], [48]]) {
    const sim = E.startShot(state, shot)
    let frame = 0
    while (!sim.done) {
      for (let step = pattern[frame % pattern.length]; step > 0 && !sim.done; step -= 1) E.stepShot(sim)
      frame += 1
    }
    assert.equal(JSON.stringify(E.finishShot(state, sim)), expected)
  }
})

test('the simulation path uses no engine-dependent maths', async () => {
  const {readFile} = await import('node:fs/promises')
  const source = await readFile(new URL('../../static/pool-engine.js', import.meta.url), 'utf8')
  const code = source.replace(/\/\/.*$/gm, '')
  const used = new Set([...code.matchAll(/Math\.([a-zA-Z0-9]+)/g)].map(match => match[1]))
  // Each of these is exactly specified by ECMAScript. sin, cos, atan2, hypot,
  // pow, exp and log are not, and would let two browsers disagree.
  assert.deepEqual([...used].sort(), ['abs', 'floor', 'imul', 'max', 'round', 'sqrt'])
  assert.ok(!/\*\*/.test(code))
  assert.ok(!/Math\.random|Date\.|performance\./.test(code))
})

// ── Physics ─────────────────────────────────────────────────────────────────

test('a straight shot hits the ball in front, and everything comes to rest on the table', () => {
  const state = tableWith({0: [750, 250], 3: [400, 250], 8: [100, 100]}, {groups: 1})
  const sim = E.startShot(state, {dx: -1, dy: 0, power: 40, place: null})
  while (!sim.done) E.stepShot(sim)
  assert.equal(sim.first, 3)
  assert.ok(sim.steps > 100)
  const after = E.finishShot(state, sim)
  assert.ok(after.balls[3][0] < 400, 'the object ball was driven forward')
  assert.equal(after.balls[3][1], 250, 'a dead straight hit stays on the line')
  assert.deepEqual(after.balls[8], [100, 100], 'an untouched ball does not move')
  for (const at of after.balls.filter(Boolean)) {
    assert.ok(at[0] >= R && at[0] <= E.TABLE.WIDTH - R && at[1] >= R && at[1] <= E.TABLE.HEIGHT - R)
  }
})

test('a ball sent at a pocket goes down', () => {
  // Object ball on the line from the cue ball to the bottom-left corner.
  const state = tableWith({0: [300, 300], 5: [150, 150], 8: [900, 250]}, {groups: 1})
  const after = E.runShot(state, {dx: -1, dy: -1, power: 60, place: null})
  assert.equal(after.balls[5], null)
  assert.deepEqual(after.last.potted, [5])
  assert.equal(after.turn, 1, 'potting your own ball keeps the table')
})

test('a full break scatters the rack and stays sane', () => {
  const state = E.initialState('m_break')
  const sim = E.startShot(state, {dx: -1, dy: 0, power: 100, place: null})
  while (!sim.done) E.stepShot(sim)
  assert.ok(sim.steps < 240 * 40, 'the break settles by itself')
  assert.ok(sim.hits > 10)
  const after = E.finishShot(state, sim)
  const moved = after.balls.filter((at, n) => n > 0 && at && (at[0] !== state.balls[n][0] || at[1] !== state.balls[n][1]))
  assert.ok(moved.length >= 10, 'most of the rack moved')
  const resting = after.balls.filter(Boolean)
  for (let a = 0; a < resting.length; a += 1) {
    for (let b = a + 1; b < resting.length; b += 1) {
      const gap = Math.hypot(resting[a][0] - resting[b][0], resting[a][1] - resting[b][1])
      assert.ok(gap > R * 2 - 0.01, 'balls came to rest overlapping')
    }
  }
  assert.equal(after.breaking, false)
  assert.ok(JSON.stringify(after).length < 2000, 'the agreed table fits well inside the backend limit')
})

// ── Shot clean-up ───────────────────────────────────────────────────────────

test('whatever is sent, both players turn it into the same shot', () => {
  const state = tableWith(everyBall())
  assert.deepEqual(E.cleanShot(state, {dx: 0, dy: 0, power: 50}), {dx: -1, dy: 0, power: 50, place: null})
  assert.deepEqual(E.cleanShot(state, {dx: NaN, dy: 1, power: 'x'}), {dx: -1, dy: 0, power: 10, place: null})
  assert.deepEqual(E.cleanShot(state, null), {dx: -1, dy: 0, power: 10, place: null})
  assert.deepEqual(E.cleanShot(state, {dx: 3, dy: 4, power: 500}), {dx: 0.6, dy: 0.8, power: 100, place: null})
  // A placement is ignored without ball in hand, and when it is not legal.
  assert.equal(E.cleanShot(state, {dx: 1, dy: 0, power: 50, place: [600, 300]}).place, null)
  const inHand = {...state, inHand: true}
  assert.deepEqual(E.cleanShot(inHand, {dx: 1, dy: 0, power: 50, place: [600, 300]}).place, [600, 300])
  for (const place of [[500, 250], [5, 250], [-40, 900], [10, 10], ['a', 1], [NaN, NaN]]) {
    assert.equal(E.cleanShot(inHand, {dx: 1, dy: 0, power: 50, place}).place, null, JSON.stringify(place))
  }
  // An ignored placement leaves the cue ball where the table has it.
  assert.equal(E.startShot(inHand, {dx: 1, dy: 0, power: 50, place: [500, 250]}).balls[0].x, 750)
  assert.equal(E.startShot(inHand, {dx: 1, dy: 0, power: 50, place: [600, 300]}).balls[0].x, 600)
})

// ── Rules ───────────────────────────────────────────────────────────────────

test('break: a pot keeps the table but assigns nothing', () => {
  const state = E.initialState('m_rules')
  const potted = outcome(state, {first: 1, potted: [3]})
  assert.deepEqual([potted.turn, potted.groups, potted.inHand, potted.breaking], [1, 0, false, false])
  const dry = outcome(state, {first: 1})
  assert.deepEqual([dry.turn, dry.groups, dry.inHand], [2, 0, false])
  assert.equal(dry.shots, 1)
})

test('break: the 8 going down is put back, not lost', () => {
  const state = E.initialState('m_rules')
  const after = outcome(state, {first: 1, potted: [8]})
  assert.equal(after.winner, 0)
  assert.ok(after.balls[8], 'the 8 is back on the table')
  assert.equal(after.turn, 2, 'the 8 alone does not keep the table')
  for (let n = 0; n < 16; n += 1) {
    if (n === 8 || !after.balls[n]) continue
    assert.ok(Math.hypot(after.balls[8][0] - after.balls[n][0], after.balls[8][1] - after.balls[n][1]) >= R * 2)
  }
  const scratch = outcome(state, {first: 1, potted: [8, 0]})
  assert.deepEqual([scratch.winner, scratch.last.foul, scratch.inHand, scratch.turn], [0, 'scratch', true, 2])
  assert.ok(scratch.balls[8] && scratch.balls[0])
})

test('open table: the first ball down decides the groups', () => {
  const state = tableWith(everyBall())
  const solid = outcome(state, {first: 2, potted: [2, 11]})
  assert.deepEqual([solid.groups, solid.turn], [1, 1])
  assert.equal(E.groupOfSeat(solid, 1), E.SOLIDS)
  assert.equal(E.groupOfSeat(solid, 2), E.STRIPES)

  const seatTwo = outcome({...state, turn: 2}, {first: 12, potted: [12]})
  assert.deepEqual([seatTwo.groups, seatTwo.turn], [1, 2], 'seat 2 on stripes means seat 1 on solids')
  assert.equal(E.groupOfSeat(seatTwo, 2), E.STRIPES)

  const miss = outcome(state, {first: 2})
  assert.deepEqual([miss.groups, miss.turn, miss.inHand], [0, 2, false])
})

test('with groups set, only your own ball keeps the table', () => {
  const state = tableWith(everyBall(), {groups: 1})
  assert.equal(outcome(state, {first: 1, potted: [1]}).turn, 1)
  assert.equal(outcome(state, {first: 1, potted: [9]}).turn, 2)
  assert.equal(outcome(state, {first: 1, potted: [9, 1]}).turn, 1)
  assert.equal(outcome(state, {first: 1}).turn, 2)
  assert.equal(outcome({...state, turn: 2}, {first: 9, potted: [9]}).turn, 2)
  assert.equal(outcome(state, {first: 1, potted: [9]}).balls[9], null, 'an opponent ball that went down stays down')
})

test('fouls pass the turn with ball in hand', () => {
  const state = tableWith(everyBall(), {groups: 1})
  const cases = [
    [{first: 1, potted: [0]}, 'scratch'],
    [{first: null}, 'no-contact'],
    [{first: 9}, 'wrong-ball'],
    [{first: 8}, 'wrong-ball'],
    [{first: 9, potted: [1]}, 'wrong-ball']
  ]
  for (const [shot, foul] of cases) {
    const after = outcome(state, shot)
    assert.deepEqual([after.last.foul, after.turn, after.inHand, after.winner], [foul, 2, true, 0], foul)
    assert.ok(after.balls[0], 'the cue ball is on the table for the next player')
  }
  // On an open table any numbered ball may be hit first, but not the 8.
  const open = tableWith(everyBall())
  assert.equal(outcome(open, {first: 12}).last.foul, '')
  assert.equal(outcome(open, {first: 8}).last.foul, 'wrong-ball')
  // A potted cue ball comes back on the head spot, or beside it if taken.
  assert.deepEqual(outcome(state, {first: 1, potted: [0]}).balls[0], [750, 250])
  const blocked = tableWith({...everyBall(), 4: [752, 251]}, {groups: 1})
  const back = outcome(blocked, {first: 1, potted: [0]}).balls[0]
  assert.ok(Math.hypot(back[0] - 752, back[1] - 251) >= R * 2)
})

test('the 8 wins only when the group was already cleared, it was hit first, and there was no foul', () => {
  const onTheEight = tableWith({0: [750, 250], 8: [500, 250], 9: [200, 100], 10: [300, 100]}, {groups: 1})
  const win = outcome(onTheEight, {first: 8, potted: [8]})
  assert.deepEqual([win.winner, win.last.end], [1, 'eight'])

  const scratch = outcome(onTheEight, {first: 8, potted: [8, 0]})
  assert.deepEqual([scratch.winner, scratch.last.end], [2, 'eight-and-scratch'])

  const wrongFirst = outcome(onTheEight, {first: 9, potted: [8]})
  assert.deepEqual([wrongFirst.winner, wrongFirst.last.end], [2, 'early-eight'])

  // Once your group is cleared, the 8 is the only legal first contact.
  assert.equal(outcome(onTheEight, {first: 9}).last.foul, 'wrong-ball')
  assert.equal(outcome(onTheEight, {first: 8}).last.foul, '')

  const notCleared = tableWith(everyBall(), {groups: 1})
  assert.equal(outcome(notCleared, {first: 1, potted: [8]}).winner, 2)
  // Potting the last ball of the group and the 8 in one shot still loses.
  const lastOne = tableWith({0: [750, 250], 8: [500, 250], 7: [400, 100], 9: [200, 100]}, {groups: 1})
  assert.equal(outcome(lastOne, {first: 7, potted: [7, 8]}).winner, 2)
  assert.equal(outcome(tableWith(everyBall()), {first: 3, potted: [8]}).winner, 2, 'the 8 on an open table loses')
  assert.equal(outcome({...onTheEight, turn: 2, groups: 2}, {first: 8, potted: [8]}).winner, 2, 'seat 2 can win too')
})

// ── Aiming aid ──────────────────────────────────────────────────────────────

test('the aim preview stops at the first ball or cushion', () => {
  const state = tableWith({0: [750, 250], 3: [400, 250]})
  const ball = E.aimPreview(state, 750, 250, -1, 0)
  assert.deepEqual([ball.ball, ball.x, ball.y], [3, 400 + R * 2, 250])
  const cushion = E.aimPreview(state, 750, 250, 1, 0)
  assert.deepEqual([cushion.ball, cushion.x], [null, E.TABLE.WIDTH - R])
  assert.equal(E.aimPreview(state, 750, 250, 0, -1).y, R)
})

// ── Whole games ─────────────────────────────────────────────────────────────

test('random games stay valid shot after shot, and replay identically', () => {
  // A small generator so the "random" play is the same on every run.
  let seed = 12345
  const random = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
    return seed / 4294967296
  }
  let finished = 0
  for (let match = 0; match < 12; match += 1) {
    let state = E.initialState('m_random_' + match)
    const shots = []
    for (let turn = 0; turn < 120 && !state.winner; turn += 1) {
      const angle = random() * Math.PI * 2
      const shot = {
        dx: Math.cos(angle),
        dy: Math.sin(angle),
        power: 20 + random() * 80,
        place: state.inHand ? [100 + random() * 800, 50 + random() * 400] : null
      }
      // Aim at a ball most of the time so something happens.
      const targets = state.balls.map((at, n) => ({n, at})).filter(item => item.n > 0 && item.at)
      if (random() < 0.8 && targets.length) {
        const target = targets[Math.floor(random() * targets.length)].at
        shot.dx = target[0] - state.balls[0][0]
        shot.dy = target[1] - state.balls[0][1]
      }
      shots.push(shot)
      const next = E.runShot(state, shot)

      assert.ok(next.turn === 1 || next.turn === 2)
      assert.ok([0, 1, 2].includes(next.winner))
      assert.equal(next.shots, state.shots + 1)
      assert.ok(JSON.stringify(next).length < 2000)
      for (let n = 0; n < 16; n += 1) {
        const at = next.balls[n]
        if (!at) {
          assert.ok(n === 8 ? next.winner !== 0 : n !== 0 || next.winner !== 0, 'ball ' + n + ' is missing')
          continue
        }
        assert.ok(Number.isFinite(at[0]) && Number.isFinite(at[1]))
        assert.ok(at[0] >= R && at[0] <= E.TABLE.WIDTH - R && at[1] >= R && at[1] <= E.TABLE.HEIGHT - R, 'ball ' + n + ' left the table')
        if (n > 0 && n !== 8) assert.ok(state.balls[n], 'ball ' + n + ' came back from a pocket')
      }
      state = next
    }
    if (state.winner) finished += 1

    // Replaying the recorded shots from the seed reproduces the final table.
    let replay = E.initialState('m_random_' + match)
    for (const shot of shots) replay = E.runShot(replay, JSON.parse(JSON.stringify(shot)))
    assert.equal(JSON.stringify(replay), JSON.stringify(state))
  }
  assert.ok(finished >= 1, 'at least one random game reached the 8-ball')
})
