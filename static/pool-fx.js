// LN Pool effects: everything about a shot that is for the eyes and ears only.
//
// This watches a simulation and never touches it. It reads ball positions and
// the engine's counters to work out how each ball has rolled, where balls
// struck each other and when one dropped, and turns that into rotation,
// flashes, pocket animations and sound. The table both players agree on is
// computed by pool-engine.js alone; a test replays shots with and without this
// file attached and requires identical results.
;(function (root) {
  'use strict'

  const E = root.PoolEngine
  const V = root.PoolView
  const R = E.BALL_RADIUS
  const REACH_SQ = R * 2 * (R * 2)
  const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1]

  function PoolFx() {
    this.spin = new Map() // ball id -> {m, x, y, known}
    this.rings = []
    this.sinks = []
    this.strike = null
    this.confetti = []
    this.hits = 0
    this.potted = 0
    this.onRail = {}
    this.struck = {}
    this.muted = false
    this.audio = null
    this.lastClick = 0
  }

  // ── Watching a shot ───────────────────────────────────────────────────────

  // A shot is starting: forget the previous one's counters and show the cue
  // driving through the ball.
  PoolFx.prototype.shotStarted = function (sim, now) {
    this.hits = sim.hits
    this.potted = sim.potted.length
    this.onRail = {}
    this.struck = {}
    const cue = sim.balls[0]
    this.strike = {x: cue.x, y: cue.y, dx: sim.shot.dx, dy: sim.shot.dy, power: sim.shot.power, at: now}
    this.play('strike', 0.35 + (0.65 * (sim.shot.power - E.MIN_POWER)) / (E.MAX_POWER - E.MIN_POWER))
  }

  // Called after every engine step while a shot is animated. Read-only.
  PoolFx.prototype.afterStep = function (sim, now) {
    const balls = sim.balls
    if (sim.hits !== this.hits) {
      this.hits = sim.hits
      // The pairs that just collided are the ones the engine left touching
      // and moving apart. In a pile-up a pair can be nudged again in the same
      // step, so "touching" has a little slack and each pair flashes once.
      for (let i = 0; i < balls.length; i += 1) {
        const a = balls[i]
        if (!a.on) continue
        for (let j = i + 1; j < balls.length; j += 1) {
          const b = balls[j]
          if (!b.on) continue
          const dx = b.x - a.x
          const dy = b.y - a.y
          const gap = dx * dx + dy * dy - REACH_SQ
          if (gap > 30 || gap < -30) continue
          const speed = Math.sqrt((b.vx - a.vx) * (b.vx - a.vx) + (b.vy - a.vy) * (b.vy - a.vy))
          if (speed < 40) continue
          const pair = i * 16 + j
          if (sim.steps - (this.struck[pair] || -100) < 24) continue
          this.struck[pair] = sim.steps
          const strength = Math.min(1, speed / 1500)
          if (strength > 0.12) this.rings.push({x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, strength, at: now})
          this.play('click', strength)
        }
      }
    }
    if (sim.potted.length !== this.potted) {
      for (let index = this.potted; index < sim.potted.length; index += 1) {
        const ball = balls[sim.potted[index]]
        const pocket = nearestPocket(ball.x, ball.y)
        const known = this.spin.get(ball.id)
        this.sinks.push({id: ball.id, x: ball.x, y: ball.y, px: pocket.x, py: pocket.y, m: known ? known.m : IDENTITY, at: now})
        this.play('pocket', 1)
      }
      this.potted = sim.potted.length
    }
    for (let i = 0; i < balls.length; i += 1) {
      const ball = balls[i]
      if (!ball.on) continue
      const touching = ball.x === R || ball.y === R || ball.x === E.TABLE.WIDTH - R || ball.y === E.TABLE.HEIGHT - R
      if (touching && !this.onRail[ball.id]) {
        const speed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy)
        if (speed > 60) this.play('rail', Math.min(1, speed / 1400))
      }
      this.onRail[ball.id] = touching
    }
  }

  // ── Rotation ──────────────────────────────────────────────────────────────

  // The table jumped to a new agreed state: the next positions are where the
  // balls are, not somewhere they rolled to.
  PoolFx.prototype.settle = function () {
    this.spin.forEach(entry => {
      entry.known = false
    })
  }

  // Give each drawn ball its orientation, rolled by however far it has moved
  // since the last frame. `vertical` says the table is drawn turned a quarter
  // turn, so that a ball still rolls the way it is seen to travel.
  PoolFx.prototype.orient = function (balls, vertical) {
    for (const ball of balls) {
      let entry = this.spin.get(ball.id)
      if (!entry) {
        entry = {m: restingOrientation(ball.id), x: ball.x, y: ball.y, known: true}
        this.spin.set(ball.id, entry)
      } else if (!entry.known) {
        entry.known = true
      } else {
        const dx = ball.x - entry.x
        const dy = ball.y - entry.y
        entry.m = vertical ? V.roll(entry.m, -dy, dx, R) : V.roll(entry.m, dx, dy, R)
      }
      entry.x = ball.x
      entry.y = ball.y
      ball.m = entry.m
    }
    return balls
  }

  // Number side up, tipped a little differently for each ball so a fresh rack
  // does not look stamped.
  function restingOrientation(id) {
    const tiltX = (((id * 37) % 11) - 5) * 0.05
    const tiltY = (((id * 53) % 9) - 4) * 0.05
    return V.roll(V.roll(IDENTITY, tiltX * R, 0, R), 0, tiltY * R, R)
  }

  // ── Transient effects ─────────────────────────────────────────────────────

  PoolFx.prototype.celebrate = function (now) {
    const colors = ['#f2c14e', '#ffffff', '#3ddc97', '#ff7a59', '#6cb6ff']
    for (let i = 0; i < 90; i += 1) {
      this.confetti.push({
        x: E.TABLE.WIDTH * (0.15 + 0.7 * Math.random()),
        y: -40 - 120 * Math.random(),
        vx: (Math.random() - 0.5) * 260,
        vy: 180 + 320 * Math.random(),
        size: 6 + 8 * Math.random(),
        turn: (Math.random() - 0.5) * 14,
        color: colors[i % colors.length],
        at: now
      })
    }
  }

  // What is still showing at `now`, with finished effects dropped.
  PoolFx.prototype.live = function (now) {
    this.rings = this.rings.filter(ring => now - ring.at < 260)
    this.sinks = this.sinks.filter(sink => now - sink.at < 320)
    this.confetti = this.confetti.filter(piece => now - piece.at < 2600)
    if (this.strike && now - this.strike.at > 320) this.strike = null
    return this
  }

  PoolFx.prototype.busy = function () {
    return this.rings.length > 0 || this.sinks.length > 0 || this.confetti.length > 0 || !!this.strike
  }

  function nearestPocket(x, y) {
    let best = E.POCKETS[0]
    let bestDistance = Infinity
    for (const pocket of E.POCKETS) {
      const distance = (pocket.x - x) * (pocket.x - x) + (pocket.y - y) * (pocket.y - y)
      if (distance < bestDistance) {
        best = pocket
        bestDistance = distance
      }
    }
    return best
  }

  // ── Sound ─────────────────────────────────────────────────────────────────
  //
  // Synthesised in the browser; there are no audio files. Browsers only start
  // audio after the player has interacted with the page, so `unlock` is called
  // from the first click or key press.

  PoolFx.prototype.unlock = function () {
    if (this.muted || typeof window === 'undefined') return
    const Context = window.AudioContext || window.webkitAudioContext
    if (!Context) return
    try {
      if (!this.audio) this.audio = new Context()
      if (this.audio.state === 'suspended') this.audio.resume().catch(() => {})
    } catch (_error) {
      this.audio = null
    }
  }

  PoolFx.prototype.setMuted = function (muted) {
    this.muted = muted
  }

  PoolFx.prototype.play = function (name, strength) {
    const audio = this.audio
    if (this.muted || !audio || audio.state !== 'running') return
    const now = audio.currentTime
    if (name === 'click') {
      // A break is dozens of contacts in a few frames; let a few through.
      if (now - this.lastClick < 0.018) return
      this.lastClick = now
      tone(audio, {type: 'triangle', from: 2300, to: 1200, length: 0.045, gain: 0.05 + 0.2 * strength})
      noise(audio, {length: 0.02, gain: 0.04 + 0.1 * strength, band: 3200})
    } else if (name === 'rail') {
      tone(audio, {type: 'sine', from: 190, to: 110, length: 0.09, gain: 0.05 + 0.14 * strength})
    } else if (name === 'strike') {
      tone(audio, {type: 'triangle', from: 900, to: 380, length: 0.06, gain: 0.1 + 0.16 * strength})
      noise(audio, {length: 0.03, gain: 0.08 * strength, band: 1800})
    } else if (name === 'pocket') {
      tone(audio, {type: 'sine', from: 170, to: 70, length: 0.22, gain: 0.22})
      noise(audio, {length: 0.12, gain: 0.07, band: 500})
    } else if (name === 'foul') {
      tone(audio, {type: 'sawtooth', from: 180, to: 120, length: 0.28, gain: 0.07})
    } else if (name === 'turn' || name === 'join') {
      tone(audio, {type: 'sine', from: 660, to: 660, length: 0.12, gain: 0.08})
      tone(audio, {type: 'sine', from: 880, to: 880, length: 0.16, gain: 0.08, delay: 0.1})
    } else if (name === 'paid' || name === 'start') {
      tone(audio, {type: 'sine', from: 523, to: 523, length: 0.1, gain: 0.08})
      tone(audio, {type: 'sine', from: 784, to: 784, length: 0.2, gain: 0.09, delay: 0.09})
    } else if (name === 'win') {
      ;[523, 659, 784, 1047].forEach((frequency, index) => {
        tone(audio, {type: 'triangle', from: frequency, to: frequency, length: 0.22, gain: 0.1, delay: index * 0.11})
      })
    } else if (name === 'lose') {
      tone(audio, {type: 'sine', from: 392, to: 392, length: 0.2, gain: 0.08})
      tone(audio, {type: 'sine', from: 294, to: 294, length: 0.34, gain: 0.08, delay: 0.18})
    }
  }

  function tone(audio, {type, from, to, length, gain, delay = 0}) {
    const start = audio.currentTime + delay
    const oscillator = audio.createOscillator()
    const volume = audio.createGain()
    oscillator.type = type
    oscillator.frequency.setValueAtTime(from, start)
    if (to !== from) oscillator.frequency.exponentialRampToValueAtTime(to, start + length)
    volume.gain.setValueAtTime(gain, start)
    volume.gain.exponentialRampToValueAtTime(0.0001, start + length)
    oscillator.connect(volume).connect(audio.destination)
    oscillator.start(start)
    oscillator.stop(start + length + 0.02)
  }

  function noise(audio, {length, gain, band}) {
    const frames = Math.max(1, Math.floor(audio.sampleRate * length))
    const buffer = audio.createBuffer(1, frames, audio.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < frames; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / frames)
    const source = audio.createBufferSource()
    const filter = audio.createBiquadFilter()
    const volume = audio.createGain()
    filter.type = 'bandpass'
    filter.frequency.value = band
    volume.gain.value = gain
    source.buffer = buffer
    source.connect(filter).connect(volume).connect(audio.destination)
    source.start()
  }

  root.PoolFx = PoolFx
})(typeof globalThis !== 'undefined' ? globalThis : this)
