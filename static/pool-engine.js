// LN Pool engine: the table, the physics and the 8-ball rules.
//
// Pure: no DOM, no clock, no randomness. Both players run this same file on
// the same shot and must arrive at the same table, bit for bit, so everything
// on the simulation path uses only + - * / and Math.sqrt, which every
// JavaScript engine computes identically. No sin, cos, atan2, hypot or pow.
//
// The physics (table proportions, constants, the step, the collision
// response, cue-ball placement, rack geometry) is adapted from billiard-clash,
// Copyright (c) 2026 Lujain-ALghamdi, MIT License. See THIRD_PARTY_NOTICES.md.
// Changed here: plain JS, a whole-step-only simulation, a seeded rack, contact
// recorded only on a real impact, and a different rule set.
;(function (root) {
  'use strict'

  // Bump this whenever a change could make the same shot end differently
  // (physics constants, the step, the rules). Two browsers on different
  // versions cannot agree on a table, so each agreed table carries the number.
  const VERSION = 1

  const TABLE = Object.freeze({
    WIDTH: 1000,
    HEIGHT: 500,
    RAIL: 30,
    FRAME: 40,
    HEAD_X: 750,
    FOOT_X: 250
  })
  const BALL_RADIUS = 12.5
  const POCKETS = Object.freeze([
    Object.freeze({x: 0, y: 0, r: 32}),
    Object.freeze({x: TABLE.WIDTH / 2, y: -4, r: 28}),
    Object.freeze({x: TABLE.WIDTH, y: 0, r: 32}),
    Object.freeze({x: 0, y: TABLE.HEIGHT, r: 32}),
    Object.freeze({x: TABLE.WIDTH / 2, y: TABLE.HEIGHT + 4, r: 28}),
    Object.freeze({x: TABLE.WIDTH, y: TABLE.HEIGHT, r: 32})
  ])

  const DT = 1 / 240
  const FRICTION = 260
  const STOP_SPEED = 4
  const BALL_RESTITUTION = 0.96
  const RAIL_RESTITUTION = 0.75
  const MIN_SPEED = 220
  const MAX_SPEED = 2400
  const MIN_POWER = 10
  const MAX_POWER = 100
  // A shot that has not settled after 40 simulated seconds is stopped where
  // it is. Nothing legitimate runs that long; this only bounds the loop.
  const MAX_STEPS = 240 * 40
  // Resting positions are snapped to this grid so the agreed table is short
  // to write down and both players start the next shot from the same numbers.
  const GRID = 1024

  const SOLIDS = 1
  const STRIPES = 2

  function ballKind(number) {
    if (number >= 1 && number <= 7) return SOLIDS
    if (number >= 9 && number <= 15) return STRIPES
    return 0
  }

  // state.groups: 0 = open table, 1 = seat 1 has solids, 2 = seat 1 has stripes.
  function groupOfSeat(state, seat) {
    if (!state.groups) return 0
    return (state.groups === 1) === (seat === 1) ? SOLIDS : STRIPES
  }

  function remaining(state, kind) {
    const left = []
    for (let number = 1; number <= 15; number += 1) {
      if (ballKind(number) === kind && state.balls[number]) left.push(number)
    }
    return left
  }

  // ── Rack ──────────────────────────────────────────────────────────────────

  function hashSeed(text) {
    let hash = 2166136261
    const value = String(text)
    for (let i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i)
      hash = Math.imul(hash, 16777619)
    }
    return hash >>> 0
  }

  // mulberry32: integer arithmetic only, so every engine agrees on it.
  function seededRandom(seed) {
    let a = seed | 0
    return function () {
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  function shuffle(list, random) {
    for (let i = list.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1))
      const held = list[i]
      list[i] = list[j]
      list[j] = held
    }
    return list
  }

  // A legal 8-ball rack: the 8 in the middle of the third row, one solid and
  // one stripe in the two back corners, the rest shuffled by the seed.
  function rack(seed) {
    const random = seededRandom(hashSeed(seed))
    const spacing = BALL_RADIUS * 2 + 0.4
    const rowStep = spacing * (Math.sqrt(3) / 2)
    const slots = []
    for (let row = 0; row < 5; row += 1) {
      for (let k = 0; k <= row; k += 1) {
        slots.push([TABLE.FOOT_X - row * rowStep, TABLE.HEIGHT / 2 + (k - row / 2) * spacing])
      }
    }
    const solids = shuffle([1, 2, 3, 4, 5, 6, 7], random)
    const stripes = shuffle([9, 10, 11, 12, 13, 14, 15], random)
    const numbers = new Array(15).fill(0)
    numbers[4] = 8
    const corners = random() < 0.5 ? [10, 14] : [14, 10]
    numbers[corners[0]] = solids.pop()
    numbers[corners[1]] = stripes.pop()
    const rest = shuffle(solids.concat(stripes), random)
    for (let slot = 0; slot < 15; slot += 1) {
      if (!numbers[slot]) numbers[slot] = rest.pop()
    }
    const balls = new Array(16).fill(null)
    balls[0] = [TABLE.HEAD_X, TABLE.HEIGHT / 2]
    for (let slot = 0; slot < 15; slot += 1) balls[numbers[slot]] = snapPoint(slots[slot][0], slots[slot][1])
    return balls
  }

  // The table both players agree on between shots. `balls[n]` is [x, y], or
  // null once ball n is down. The backend reads `turn` and `winner` only.
  function initialState(seed) {
    return {
      engine: VERSION,
      balls: rack(seed),
      turn: 1,
      groups: 0,
      inHand: false,
      breaking: true,
      winner: 0,
      shots: 0,
      last: null
    }
  }

  // ── Placement ─────────────────────────────────────────────────────────────

  function snap(value) {
    return Math.round(value * GRID) / GRID
  }

  function snapPoint(x, y) {
    return [snap(x), snap(y)]
  }

  // Where a ball may be set down: on the cloth, clear of every ball in
  // `balls` except `ignore`, and not hanging in a pocket mouth.
  function isFreeSpot(balls, x, y, ignore) {
    if (!(x - BALL_RADIUS >= 0) || !(x + BALL_RADIUS <= TABLE.WIDTH)) return false
    if (!(y - BALL_RADIUS >= 0) || !(y + BALL_RADIUS <= TABLE.HEIGHT)) return false
    const reach = BALL_RADIUS * 2
    for (let number = 0; number < balls.length; number += 1) {
      const other = balls[number]
      if (!other || number === ignore) continue
      const dx = x - other[0]
      const dy = y - other[1]
      if (dx * dx + dy * dy < reach * reach) return false
    }
    for (const pocket of POCKETS) {
      const dx = x - pocket.x
      const dy = y - pocket.y
      const keepOut = pocket.r + BALL_RADIUS * 0.5
      if (dx * dx + dy * dy < keepOut * keepOut) return false
    }
    return true
  }

  function isLegalCuePosition(state, x, y) {
    return isFreeSpot(state.balls, x, y, 0)
  }

  // The free spot nearest to (x, y), searched in a fixed order so both
  // players find the same one.
  function nearestFreeSpot(balls, x, y, ignore) {
    for (let ring = 0; ring <= 80; ring += 1) {
      for (let iy = -ring; iy <= ring; iy += 1) {
        for (let ix = -ring; ix <= ring; ix += 1) {
          if (Math.max(Math.abs(ix), Math.abs(iy)) !== ring) continue
          const px = x + ix * BALL_RADIUS
          const py = y + iy * BALL_RADIUS
          if (isFreeSpot(balls, px, py, ignore)) return snapPoint(px, py)
        }
      }
    }
    return snapPoint(x, y)
  }

  // ── Shots ─────────────────────────────────────────────────────────────────

  // Whatever arrives, both players turn it into the same shot.
  function cleanShot(state, shot) {
    let dx = Number(shot && shot.dx)
    let dy = Number(shot && shot.dy)
    const length = Math.sqrt(dx * dx + dy * dy)
    if (length > 1e-9 && length < 1e9) {
      dx /= length
      dy /= length
    } else {
      dx = -1
      dy = 0
    }
    let power = Number(shot && shot.power)
    if (!(power >= MIN_POWER)) power = MIN_POWER
    if (power > MAX_POWER) power = MAX_POWER
    let place = null
    if (state.inHand && shot && Array.isArray(shot.place)) {
      const x = snap(Number(shot.place[0]))
      const y = snap(Number(shot.place[1]))
      if (isLegalCuePosition(state, x, y)) place = [x, y]
    }
    return {dx, dy, power, place}
  }

  function shotSpeed(power) {
    return MIN_SPEED + ((power - MIN_POWER) / (MAX_POWER - MIN_POWER)) * (MAX_SPEED - MIN_SPEED)
  }

  // Begin simulating `shot` on the agreed table `state`. The returned object
  // is advanced with stepShot until `done`, then handed to finishShot.
  function startShot(state, shot) {
    const clean = cleanShot(state, shot)
    const balls = []
    for (let number = 0; number < 16; number += 1) {
      const at = state.balls[number]
      balls.push({id: number, x: at ? at[0] : 0, y: at ? at[1] : 0, vx: 0, vy: 0, on: !!at})
    }
    const cue = balls[0]
    if (clean.place) {
      cue.x = clean.place[0]
      cue.y = clean.place[1]
    }
    const speed = shotSpeed(clean.power)
    cue.on = true
    cue.vx = clean.dx * speed
    cue.vy = clean.dy * speed
    return {balls, shot: clean, steps: 0, done: false, first: null, potted: [], hits: 0}
  }

  function stepShot(sim) {
    if (sim.done) return sim
    const balls = sim.balls
    let moving = false

    // 1. Move, then slow by rolling friction.
    for (let i = 0; i < balls.length; i += 1) {
      const ball = balls[i]
      if (!ball.on) continue
      const speed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy)
      if (speed < STOP_SPEED) {
        ball.vx = 0
        ball.vy = 0
        continue
      }
      moving = true
      ball.x += ball.vx * DT
      ball.y += ball.vy * DT
      const slowed = Math.max(0, speed - FRICTION * DT) / speed
      ball.vx *= slowed
      ball.vy *= slowed
    }

    // 2. Ball against ball: equal masses, separated first so they never overlap.
    const reach = BALL_RADIUS * 2
    for (let i = 0; i < balls.length; i += 1) {
      const a = balls[i]
      if (!a.on) continue
      for (let j = i + 1; j < balls.length; j += 1) {
        const b = balls[j]
        if (!b.on) continue
        const dx = b.x - a.x
        const dy = b.y - a.y
        const distanceSq = dx * dx + dy * dy
        if (distanceSq >= reach * reach || distanceSq === 0) continue
        const distance = Math.sqrt(distanceSq)
        const nx = dx / distance
        const ny = dy / distance
        const push = (reach - distance) / 2
        a.x -= nx * push
        a.y -= ny * push
        b.x += nx * push
        b.y += ny * push
        const approach = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny
        if (approach >= 0) continue
        const impulse = (-(1 + BALL_RESTITUTION) * approach) / 2
        a.vx -= nx * impulse
        a.vy -= ny * impulse
        b.vx += nx * impulse
        b.vy += ny * impulse
        sim.hits += 1
        if (sim.first === null && a.id === 0) sim.first = b.id
      }
    }

    // 3. Cushions.
    for (let i = 0; i < balls.length; i += 1) {
      const ball = balls[i]
      if (!ball.on) continue
      if (ball.x - BALL_RADIUS < 0) {
        ball.x = BALL_RADIUS
        ball.vx = Math.abs(ball.vx) * RAIL_RESTITUTION
      } else if (ball.x + BALL_RADIUS > TABLE.WIDTH) {
        ball.x = TABLE.WIDTH - BALL_RADIUS
        ball.vx = -Math.abs(ball.vx) * RAIL_RESTITUTION
      }
      if (ball.y - BALL_RADIUS < 0) {
        ball.y = BALL_RADIUS
        ball.vy = Math.abs(ball.vy) * RAIL_RESTITUTION
      } else if (ball.y + BALL_RADIUS > TABLE.HEIGHT) {
        ball.y = TABLE.HEIGHT - BALL_RADIUS
        ball.vy = -Math.abs(ball.vy) * RAIL_RESTITUTION
      }
    }

    // 4. Pockets.
    for (let i = 0; i < balls.length; i += 1) {
      const ball = balls[i]
      if (!ball.on) continue
      for (const pocket of POCKETS) {
        const dx = ball.x - pocket.x
        const dy = ball.y - pocket.y
        if (dx * dx + dy * dy > pocket.r * pocket.r) continue
        ball.on = false
        ball.vx = 0
        ball.vy = 0
        sim.potted.push(ball.id)
        break
      }
    }

    sim.steps += 1
    if (!moving || sim.steps >= MAX_STEPS) {
      for (const ball of balls) {
        ball.vx = 0
        ball.vy = 0
      }
      sim.done = true
    }
    return sim
  }

  // ── Rules ─────────────────────────────────────────────────────────────────
  //
  // The whole rule set, which is deliberately shorter than tournament 8-ball:
  //  1. Seat 1 breaks from the head spot. Nothing potted on the break assigns
  //     a group, but potting any numbered ball keeps the table.
  //  2. The table is open until the first legal pot after the break; the
  //     first ball down decides the shooter's group.
  //  3. Pot one of your own and shoot again. Otherwise the turn passes.
  //  4. Fouls: potting the cue ball, hitting nothing, or hitting the wrong
  //     ball first (an opponent's ball; the 8 while the table is open or your
  //     group is not cleared; anything but the 8 once it is). A foul passes
  //     the turn with ball in hand anywhere on the table.
  //  5. Potting the 8 wins if your group was already cleared, you hit the 8
  //     first and did not foul. Any other way of potting it loses.
  //  6. The 8 going down on the break is not a loss: it is put back on the
  //     foot spot.
  // No called pockets, no rail-after-contact rule, no three-foul rule.

  function legalFirstContact(state, group, first) {
    if (state.breaking) return true
    if (!group) return first !== 8
    if (remaining(state, group).length === 0) return first === 8
    return ballKind(first) === group
  }

  // Judge a finished simulation and produce the next agreed table.
  function finishShot(state, sim) {
    const shooter = state.turn
    const opponent = shooter === 1 ? 2 : 1
    const group = groupOfSeat(state, shooter)
    const potted = sim.potted.slice()
    const cuePotted = potted.indexOf(0) !== -1
    const eightPotted = potted.indexOf(8) !== -1
    const numbered = potted.filter(number => number !== 0 && number !== 8)

    let foul = ''
    if (cuePotted) foul = 'scratch'
    else if (sim.first === null) foul = 'no-contact'
    else if (!legalFirstContact(state, group, sim.first)) foul = 'wrong-ball'

    const balls = new Array(16).fill(null)
    for (const ball of sim.balls) {
      if (ball.on) balls[ball.id] = snapPoint(ball.x, ball.y)
    }

    let winner = 0
    let end = ''
    let groups = state.groups
    let turn = opponent
    let inHand = false

    if (eightPotted && !state.breaking) {
      const cleared = group !== 0 && remaining(state, group).length === 0
      if (!foul && cleared && sim.first === 8) {
        winner = shooter
        end = 'eight'
      } else {
        winner = opponent
        end = foul === 'scratch' ? 'eight-and-scratch' : 'early-eight'
      }
      turn = winner
    } else {
      if (eightPotted) balls[8] = nearestFreeSpot(balls, TABLE.FOOT_X, TABLE.HEIGHT / 2, 8)
      if (foul) {
        inHand = true
      } else if (state.breaking) {
        if (numbered.length > 0) turn = shooter
      } else if (!group) {
        if (numbered.length > 0) {
          groups = (ballKind(numbered[0]) === SOLIDS) === (shooter === 1) ? 1 : 2
          turn = shooter
        }
      } else if (numbered.some(number => ballKind(number) === group)) {
        turn = shooter
      }
      // A potted cue ball comes back on the head spot, or as near to it as
      // fits; the incoming player may then move it.
      if (!balls[0]) balls[0] = nearestFreeSpot(balls, TABLE.HEAD_X, TABLE.HEIGHT / 2, 0)
    }

    return {
      engine: VERSION,
      balls,
      turn,
      groups,
      inHand,
      breaking: false,
      winner,
      shots: state.shots + 1,
      last: {seat: shooter, foul, potted, first: sim.first, end}
    }
  }

  // Simulate a whole shot without drawing it.
  function runShot(state, shot) {
    const sim = startShot(state, shot)
    while (!sim.done) stepShot(sim)
    return finishShot(state, sim)
  }

  // ── Aiming aid (drawing only, never part of the agreed result) ────────────

  // Where the cue ball first touches something if struck from (x, y) along
  // the unit direction (dx, dy): {x, y, ball} with ball = null for a cushion.
  function aimPreview(state, x, y, dx, dy) {
    let best = Infinity
    let ball = null
    const reach = BALL_RADIUS * 2
    for (let number = 1; number < 16; number += 1) {
      const at = state.balls[number]
      if (!at) continue
      const ox = at[0] - x
      const oy = at[1] - y
      const along = ox * dx + oy * dy
      if (along <= 0) continue
      const offSq = ox * ox + oy * oy - along * along
      if (offSq >= reach * reach) continue
      const t = along - Math.sqrt(reach * reach - offSq)
      if (t >= 0 && t < best) {
        best = t
        ball = number
      }
    }
    const walls = [
      dx > 0 ? (TABLE.WIDTH - BALL_RADIUS - x) / dx : dx < 0 ? (BALL_RADIUS - x) / dx : Infinity,
      dy > 0 ? (TABLE.HEIGHT - BALL_RADIUS - y) / dy : dy < 0 ? (BALL_RADIUS - y) / dy : Infinity
    ]
    for (const t of walls) {
      if (t >= 0 && t < best) {
        best = t
        ball = null
      }
    }
    if (!Number.isFinite(best)) best = 0
    return {x: x + dx * best, y: y + dy * best, ball}
  }

  root.PoolEngine = Object.freeze({
    VERSION,
    TABLE,
    BALL_RADIUS,
    POCKETS,
    DT,
    MIN_POWER,
    MAX_POWER,
    SOLIDS,
    STRIPES,
    ballKind,
    groupOfSeat,
    remaining,
    initialState,
    isLegalCuePosition,
    cleanShot,
    startShot,
    stepShot,
    finishShot,
    runShot,
    aimPreview
  })
})(typeof globalThis !== 'undefined' ? globalThis : this)
