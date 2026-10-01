// LN Pool table renderer: draws the table, the balls, the cue and the effects
// on a 2D canvas, and converts pointer positions to table coordinates. It
// draws what it is given and holds no game state.
//
// Started from billiard-clash's TableRenderer, Copyright (c) 2026
// Lujain-ALghamdi, MIT License (see THIRD_PARTY_NOTICES.md); the table art,
// the lit rolling balls, the cue and the portrait layout were written here.
;(function (root) {
  'use strict'

  const E = root.PoolEngine
  const W = E.TABLE.WIDTH
  const H = E.TABLE.HEIGHT
  const R = E.BALL_RADIUS
  const TAU = Math.PI * 2

  // Drawn dimensions around the playing surface, in table units. The playing
  // surface itself is exactly the rectangle the physics uses.
  const CUSHION = 22
  const BORDER = 66
  const TOTAL_W = W + BORDER * 2
  const TOTAL_H = H + BORDER * 2
  // Where the cushion noses stop short of each pocket.
  const CORNER_NOSE = 44
  const CORNER_BACK = 30
  const SIDE_NOSE = 30
  const SIDE_BACK = 24

  const COLORS = [
    [246, 243, 234],
    [244, 196, 48],
    [30, 79, 216],
    [209, 39, 44],
    [106, 44, 145],
    [230, 119, 46],
    [28, 122, 77],
    [122, 31, 31],
    [22, 22, 22]
  ]
  const IVORY = [246, 243, 234]
  const INK = [20, 20, 20]
  const CUE_DOT = [96, 118, 168]
  const SPOT = 0.83 // cos of the number spot's angular radius
  const SPOT_SIN = Math.sqrt(1 - SPOT * SPOT)
  const LIGHT = normalize([-0.45, -0.6, 0.66])
  const HALF = normalize([LIGHT[0], LIGHT[1], LIGHT[2] + 1])
  const GLYPH = 48

  function PoolTable(canvas) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.vertical = false
    this.sponsor = '' // optional text on the cloth; empty draws nothing
    this.scale = 1
    this.width = 0
    this.height = 0
    this.dpr = 1
    this.layer = null
    this.sprites = new Map()
    this.glyphs = new Map()
  }

  PoolTable.ASPECT = TOTAL_W / TOTAL_H

  // Match the backing store to the canvas's laid-out size. Call when the size
  // or the orientation changes.
  PoolTable.prototype.resize = function () {
    const width = this.canvas.clientWidth
    const height = this.canvas.clientHeight
    if (!width || !height) return
    this.dpr = Math.min(window.devicePixelRatio || 1, 2)
    this.width = width
    this.height = height
    this.canvas.width = Math.round(width * this.dpr)
    this.canvas.height = Math.round(height * this.dpr)
    const across = this.vertical ? TOTAL_H : TOTAL_W
    const down = this.vertical ? TOTAL_W : TOTAL_H
    this.scale = Math.min(width / across, height / down)
    this.ox = (width - across * this.scale) / 2 + BORDER * this.scale
    this.oy = (height - down * this.scale) / 2 + BORDER * this.scale
    this.layer = null
    this.sprites.clear()
  }

  // Portrait screens get the table turned a quarter turn, head rail at the
  // bottom, so the balls are not the size of peas.
  PoolTable.prototype.setVertical = function (vertical) {
    if (this.vertical === vertical) return
    this.vertical = vertical
    this.resize()
  }

  PoolTable.prototype.toScreen = function (x, y) {
    if (this.vertical) return {x: this.ox + (H - y) * this.scale, y: this.oy + x * this.scale}
    return {x: this.ox + x * this.scale, y: this.oy + y * this.scale}
  }

  // Pointer event -> table coordinates.
  PoolTable.prototype.toTable = function (event) {
    const box = this.canvas.getBoundingClientRect()
    const sx = event.clientX - box.left
    const sy = event.clientY - box.top
    if (this.vertical) return {x: (sy - this.oy) / this.scale, y: H - (sx - this.ox) / this.scale}
    return {x: (sx - this.ox) / this.scale, y: (sy - this.oy) / this.scale}
  }

  // A direction on the table as a direction on the screen.
  PoolTable.prototype.turn = function (dx, dy) {
    return this.vertical ? {x: -dy, y: dx} : {x: dx, y: dy}
  }

  // scene: {
  //   balls:  [{id, x, y, m}]              m = 3x3 orientation, optional
  //   aim:    {x, y, dx, dy, power, mine}  cue and aim line from (x, y), or null
  //   ghost:  {x, y, ball}                 where the cue ball first lands, or null
  //   place:  {x, y, legal}                ball-in-hand marker, or null
  //   fx:     PoolFx                       transient effects, or null
  //   now:    ms
  // }
  PoolTable.prototype.draw = function (scene) {
    if (!this.width) this.resize()
    if (!this.width) return
    const ctx = this.ctx
    const dpr = this.dpr
    if (!this.layer) this.layer = this.paintTable()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    ctx.drawImage(this.layer, 0, 0)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const fx = scene.fx
    const now = scene.now || 0
    const radius = R * this.scale

    if (fx) for (const sink of fx.sinks) this.drawSink(sink, now, radius)
    for (const ball of scene.balls) this.drawShadow(ball, radius)
    if (scene.aim && scene.ghost) this.drawAimLine(scene.aim, scene.ghost, now)
    for (const ball of scene.balls) {
      const at = this.toScreen(ball.x, ball.y)
      this.drawBall(ball.id, at.x, at.y, radius, ball.m)
    }
    if (scene.place) this.drawPlacement(scene.place, now)
    if (fx) for (const ring of fx.rings) this.drawRing(ring, now)
    if (scene.aim) this.drawCue(scene.aim, 0, 1)
    if (fx && fx.strike) this.drawStrike(fx.strike, now)
    if (fx) for (const piece of fx.confetti) this.drawConfetti(piece, now)
  }

  // ── The table, painted once per size ──────────────────────────────────────

  PoolTable.prototype.paintTable = function () {
    const layer = document.createElement('canvas')
    layer.width = this.canvas.width
    layer.height = this.canvas.height
    const ctx = layer.getContext('2d')
    const k = this.scale * this.dpr
    // Everything below is drawn in table units.
    if (this.vertical) ctx.setTransform(0, k, -k, 0, (this.ox + H * this.scale) * this.dpr, this.oy * this.dpr)
    else ctx.setTransform(k, 0, 0, k, this.ox * this.dpr, this.oy * this.dpr)

    // Frame.
    ctx.save()
    ctx.shadowColor = 'rgba(0, 0, 0, 0.6)'
    ctx.shadowBlur = 26 * this.dpr
    ctx.shadowOffsetY = 8 * this.dpr
    const wood = ctx.createLinearGradient(0, -BORDER, 0, H + BORDER)
    wood.addColorStop(0, '#7a4a28')
    wood.addColorStop(0.5, '#56311a')
    wood.addColorStop(1, '#3e2212')
    ctx.fillStyle = wood
    roundRect(ctx, -BORDER, -BORDER, TOTAL_W, TOTAL_H, 34)
    ctx.fill()
    ctx.restore()

    // Grain.
    ctx.save()
    roundRect(ctx, -BORDER, -BORDER, TOTAL_W, TOTAL_H, 34)
    ctx.clip()
    const random = generator(7)
    for (let i = 0; i < 70; i += 1) {
      const y = -BORDER + random() * TOTAL_H
      ctx.strokeStyle = random() < 0.5 ? 'rgba(255, 220, 170, 0.045)' : 'rgba(0, 0, 0, 0.07)'
      ctx.lineWidth = 0.6 + random() * 1.6
      ctx.beginPath()
      ctx.moveTo(-BORDER, y)
      ctx.bezierCurveTo(W * 0.3, y + (random() - 0.5) * 14, W * 0.7, y + (random() - 0.5) * 14, W + BORDER, y + (random() - 0.5) * 8)
      ctx.stroke()
    }
    ctx.restore()
    ctx.strokeStyle = 'rgba(255, 225, 180, 0.16)'
    ctx.lineWidth = 1.5
    roundRect(ctx, -BORDER + 2, -BORDER + 2, TOTAL_W - 4, TOTAL_H - 4, 32)
    ctx.stroke()

    // The bed the cushions sit on, then the cloth.
    ctx.fillStyle = '#1b110a'
    roundRect(ctx, -CUSHION - 4, -CUSHION - 4, W + CUSHION * 2 + 8, H + CUSHION * 2 + 8, 16)
    ctx.fill()
    ctx.fillStyle = '#0a3324'
    roundRect(ctx, -CUSHION, -CUSHION, W + CUSHION * 2, H + CUSHION * 2, 12)
    ctx.fill()

    const cloth = ctx.createRadialGradient(W / 2, H / 2, 40, W / 2, H / 2, W * 0.62)
    cloth.addColorStop(0, '#1f8f63')
    cloth.addColorStop(0.6, '#157450')
    cloth.addColorStop(1, '#0e5a3d')
    ctx.fillStyle = cloth
    ctx.fillRect(0, 0, W, H)
    ctx.fillStyle = ctx.createPattern(clothTexture(), 'repeat')
    ctx.fillRect(0, 0, W, H)

    // Markings.
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.09)'
    ctx.lineWidth = 1.2
    ctx.beginPath()
    ctx.moveTo(E.TABLE.HEAD_X, 0)
    ctx.lineTo(E.TABLE.HEAD_X, H)
    ctx.stroke()
    ctx.fillStyle = 'rgba(255, 255, 255, 0.16)'
    for (const x of [E.TABLE.FOOT_X, E.TABLE.HEAD_X]) {
      ctx.beginPath()
      ctx.arc(x, H / 2, 3, 0, TAU)
      ctx.fill()
    }
    if (this.sponsor) {
      ctx.save()
      ctx.fillStyle = 'rgba(255, 255, 255, 0.07)'
      ctx.font = '700 54px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(String(this.sponsor).slice(0, 24), W / 2, H / 2)
      ctx.restore()
    }

    // Shade thrown onto the cloth by the cushions.
    for (const [x0, y0, x1, y1, rx, ry, rw, rh] of [
      [0, 0, 0, 16, 0, 0, W, 16],
      [0, H, 0, H - 16, 0, H - 16, W, 16],
      [0, 0, 16, 0, 0, 0, 16, H],
      [W, 0, W - 16, 0, W - 16, 0, 16, H]
    ]) {
      const shade = ctx.createLinearGradient(x0, y0, x1, y1)
      shade.addColorStop(0, 'rgba(0, 0, 0, 0.3)')
      shade.addColorStop(1, 'rgba(0, 0, 0, 0)')
      ctx.fillStyle = shade
      ctx.fillRect(rx, ry, rw, rh)
    }

    // Pockets, under the cushion ends.
    for (const pocket of E.POCKETS) {
      const corner = pocket.r > 30
      const cx = corner ? pocket.x + (pocket.x === 0 ? -9 : 9) : pocket.x
      const cy = corner ? pocket.y + (pocket.y === 0 ? -9 : 9) : pocket.y < 0 ? -15 : H + 15
      const radius = corner ? 31 : 26
      ctx.fillStyle = '#2a1a0e'
      ctx.beginPath()
      ctx.arc(cx, cy, radius + 5, 0, TAU)
      ctx.fill()
      const hole = ctx.createRadialGradient(cx, cy, 2, cx, cy, radius)
      hole.addColorStop(0, '#000000')
      hole.addColorStop(0.75, '#050505')
      hole.addColorStop(1, '#141414')
      ctx.fillStyle = hole
      ctx.beginPath()
      ctx.arc(cx, cy, radius, 0, TAU)
      ctx.fill()
    }

    // Cushions: back edge against the rail, nose on the playing surface.
    const cushions = [
      [[CORNER_BACK, -CUSHION], [W / 2 - SIDE_BACK, -CUSHION], [W / 2 - SIDE_NOSE, 0], [CORNER_NOSE, 0]],
      [[W / 2 + SIDE_BACK, -CUSHION], [W - CORNER_BACK, -CUSHION], [W - CORNER_NOSE, 0], [W / 2 + SIDE_NOSE, 0]],
      [[CORNER_BACK, H + CUSHION], [W / 2 - SIDE_BACK, H + CUSHION], [W / 2 - SIDE_NOSE, H], [CORNER_NOSE, H]],
      [[W / 2 + SIDE_BACK, H + CUSHION], [W - CORNER_BACK, H + CUSHION], [W - CORNER_NOSE, H], [W / 2 + SIDE_NOSE, H]],
      [[-CUSHION, CORNER_BACK], [-CUSHION, H - CORNER_BACK], [0, H - CORNER_NOSE], [0, CORNER_NOSE]],
      [[W + CUSHION, CORNER_BACK], [W + CUSHION, H - CORNER_BACK], [W, H - CORNER_NOSE], [W, CORNER_NOSE]]
    ]
    for (const points of cushions) {
      const back = points[0]
      const nose = points[3]
      const horizontal = back[1] === points[1][1]
      const face = horizontal
        ? ctx.createLinearGradient(0, back[1], 0, nose[1])
        : ctx.createLinearGradient(back[0], 0, nose[0], 0)
      face.addColorStop(0, '#0d4a33')
      face.addColorStop(0.7, '#17805a')
      face.addColorStop(1, '#22a070')
      ctx.fillStyle = face
      ctx.beginPath()
      ctx.moveTo(points[0][0], points[0][1])
      for (let i = 1; i < 4; i += 1) ctx.lineTo(points[i][0], points[i][1])
      ctx.closePath()
      ctx.fill()
      ctx.strokeStyle = 'rgba(190, 255, 220, 0.22)'
      ctx.lineWidth = 1.2
      ctx.beginPath()
      ctx.moveTo(points[2][0], points[2][1])
      ctx.lineTo(points[3][0], points[3][1])
      ctx.stroke()
    }

    // Sights on the rail.
    const sight = BORDER - (BORDER - CUSHION) / 2
    ctx.fillStyle = 'rgba(244, 232, 205, 0.85)'
    for (let i = 1; i <= 7; i += 1) {
      if (i === 4) continue
      diamond(ctx, (W / 8) * i, -sight, 5)
      diamond(ctx, (W / 8) * i, H + sight, 5)
    }
    for (let i = 1; i <= 3; i += 1) {
      diamond(ctx, -sight, (H / 4) * i, 5)
      diamond(ctx, W + sight, (H / 4) * i, 5)
    }
    return layer
  }

  let texture = null
  function clothTexture() {
    if (texture) return texture
    texture = document.createElement('canvas')
    texture.width = 120
    texture.height = 120
    const ctx = texture.getContext('2d')
    const random = generator(3)
    for (let i = 0; i < 2600; i += 1) {
      ctx.fillStyle = random() < 0.5 ? 'rgba(255, 255, 255, 0.035)' : 'rgba(0, 0, 0, 0.05)'
      ctx.fillRect(random() * 120, random() * 120, 1 + random(), 1 + random())
    }
    return texture
  }

  // ── Balls ─────────────────────────────────────────────────────────────────

  PoolTable.prototype.drawShadow = function (ball, radius) {
    const ctx = this.ctx
    const at = this.toScreen(ball.x, ball.y)
    const x = at.x + radius * 0.28
    const y = at.y + radius * 0.4
    const shade = ctx.createRadialGradient(x, y, radius * 0.3, x, y, radius * 1.3)
    shade.addColorStop(0, 'rgba(0, 0, 0, 0.42)')
    shade.addColorStop(1, 'rgba(0, 0, 0, 0)')
    ctx.fillStyle = shade
    ctx.beginPath()
    ctx.arc(x, y, radius * 1.3, 0, TAU)
    ctx.fill()
  }

  // A ball is a small image rendered pixel by pixel as a lit sphere, so its
  // stripe and number travel round it as it rolls. The image is only redrawn
  // when the ball's orientation changes.
  PoolTable.prototype.drawBall = function (id, sx, sy, radius, matrix, alpha) {
    const m = matrix || [1, 0, 0, 0, 1, 0, 0, 0, 1]
    const pixels = radius * this.dpr
    const size = Math.max(4, Math.ceil(pixels * 2) + 2)
    let key = String(size)
    for (let i = 0; i < 9; i += 1) key += ',' + Math.round(m[i] * 160)
    let sprite = this.sprites.get(id)
    if (!sprite || sprite.size !== size) {
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')
      sprite = {canvas, ctx, size, key: '', image: ctx.createImageData(size, size)}
      this.sprites.set(id, sprite)
    }
    if (sprite.key !== key) {
      this.shadeBall(sprite.image.data, size, pixels, id, m)
      sprite.ctx.putImageData(sprite.image, 0, 0)
      sprite.key = key
    }
    const drawn = size / this.dpr
    const ctx = this.ctx
    if (alpha !== undefined) ctx.globalAlpha = alpha
    ctx.drawImage(sprite.canvas, sx - drawn / 2, sy - drawn / 2, drawn, drawn)
    if (alpha !== undefined) ctx.globalAlpha = 1
  }

  PoolTable.prototype.shadeBall = function (data, size, pixels, id, m) {
    const striped = id > 8
    const color = id === 0 ? IVORY : COLORS[striped ? id - 8 : id]
    const glyph = id === 0 ? null : this.glyph(id)
    const half = size / 2
    let offset = 0
    for (let py = 0; py < size; py += 1) {
      const v = (py + 0.5 - half) / pixels
      for (let px = 0; px < size; px += 1, offset += 4) {
        const u = (px + 0.5 - half) / pixels
        const rr = u * u + v * v
        const edge = (1 - Math.sqrt(rr)) * pixels + 0.5
        if (edge <= 0) {
          data[offset + 3] = 0
          continue
        }
        const z = rr < 1 ? Math.sqrt(1 - rr) : 0
        // The same point in the ball's own frame.
        const qx = m[0] * u + m[3] * v + m[6] * z
        const qy = m[1] * u + m[4] * v + m[7] * z
        const qz = m[2] * u + m[5] * v + m[8] * z

        let r = color[0]
        let g = color[1]
        let b = color[2]
        if (id === 0) {
          if (qx > 0.982 || qx < -0.982 || qy > 0.982 || qy < -0.982 || qz > 0.982 || qz < -0.982) {
            r = CUE_DOT[0]
            g = CUE_DOT[1]
            b = CUE_DOT[2]
          }
        } else {
          if (striped && (qy > 0.56 || qy < -0.56)) {
            r = IVORY[0]
            g = IVORY[1]
            b = IVORY[2]
          }
          if (qz > SPOT || qz < -SPOT) {
            // Number spot: sample the glyph, flipped on the far side so it
            // reads the right way round when it comes into view.
            const a = ((qz > 0 ? qx : -qx) / SPOT_SIN) * 0.5 + 0.5
            const c = (qy / SPOT_SIN) * 0.5 + 0.5
            const gx = Math.min(GLYPH - 1, Math.max(0, Math.floor(a * GLYPH)))
            const gy = Math.min(GLYPH - 1, Math.max(0, Math.floor(c * GLYPH)))
            const ink = glyph[gy * GLYPH + gx]
            r = IVORY[0] + (INK[0] - IVORY[0]) * ink
            g = IVORY[1] + (INK[1] - IVORY[1]) * ink
            b = IVORY[2] + (INK[2] - IVORY[2]) * ink
          }
        }

        const lit = u * LIGHT[0] + v * LIGHT[1] + z * LIGHT[2]
        const diffuse = 0.36 + 0.64 * (lit > 0 ? lit : 0)
        const facing = u * HALF[0] + v * HALF[1] + z * HALF[2]
        let gloss = facing > 0 ? facing : 0
        gloss = gloss * gloss
        gloss = gloss * gloss
        gloss = gloss * gloss
        gloss = gloss * gloss * gloss * 190
        data[offset] = Math.min(255, r * diffuse + gloss)
        data[offset + 1] = Math.min(255, g * diffuse + gloss)
        data[offset + 2] = Math.min(255, b * diffuse + gloss)
        data[offset + 3] = edge >= 1 ? 255 : edge * 255
      }
    }
  }

  // The number on a ball's spot, as a GLYPH x GLYPH map of ink coverage.
  PoolTable.prototype.glyph = function (id) {
    let map = this.glyphs.get(id)
    if (map) return map
    const canvas = document.createElement('canvas')
    canvas.width = GLYPH
    canvas.height = GLYPH
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, GLYPH, GLYPH)
    ctx.fillStyle = '#000'
    ctx.font = '900 ' + (id > 9 ? 24 : 29) + 'px Arial, Helvetica, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(id), GLYPH / 2, GLYPH / 2 + 1)
    // 6 and 9 are told apart by a bar underneath.
    if (id === 6 || id === 9) ctx.fillRect(GLYPH / 2 - 7, GLYPH / 2 + 13, 14, 3)
    const pixels = ctx.getImageData(0, 0, GLYPH, GLYPH).data
    map = new Float32Array(GLYPH * GLYPH)
    for (let i = 0; i < map.length; i += 1) map[i] = 1 - pixels[i * 4] / 255
    this.glyphs.set(id, map)
    return map
  }

  // ── Aiming ────────────────────────────────────────────────────────────────

  PoolTable.prototype.drawAimLine = function (aim, ghost, now) {
    const ctx = this.ctx
    const from = this.toScreen(aim.x, aim.y)
    const to = this.toScreen(ghost.x, ghost.y)
    const radius = R * this.scale
    ctx.save()
    ctx.lineCap = 'round'
    ctx.strokeStyle = aim.mine ? 'rgba(255, 244, 214, 0.8)' : 'rgba(255, 255, 255, 0.32)'
    ctx.lineWidth = aim.mine ? 1.6 : 1.2
    ctx.setLineDash([7, 9])
    ctx.lineDashOffset = aim.mine ? -(now / 45) % 16 : 0
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.lineTo(to.x, to.y)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.lineWidth = 1.4
    ctx.beginPath()
    ctx.arc(to.x, to.y, radius, 0, TAU)
    ctx.stroke()
    ctx.restore()
  }

  // The cue lies behind the cue ball, drawn back further the harder the shot.
  // `advance` moves it toward the ball (the strike), `alpha` fades it.
  PoolTable.prototype.drawCue = function (aim, advance, alpha) {
    const ctx = this.ctx
    const s = this.scale
    const direction = this.turn(aim.dx, aim.dy)
    const origin = this.toScreen(aim.x, aim.y)
    const power = (aim.power - E.MIN_POWER) / (E.MAX_POWER - E.MIN_POWER)
    const gap = (R + 5 + power * 78 * (1 - advance)) * s
    const nx = -direction.y
    const ny = direction.x
    const along = distance => ({x: origin.x - direction.x * (gap + distance * s), y: origin.y - direction.y * (gap + distance * s)})
    const section = (start, end, startWidth, endWidth, fill) => {
      const a = along(start)
      const b = along(end)
      const wa = (startWidth * s) / 2
      const wb = (endWidth * s) / 2
      ctx.fillStyle = fill
      ctx.beginPath()
      ctx.moveTo(a.x + nx * wa, a.y + ny * wa)
      ctx.lineTo(b.x + nx * wb, b.y + ny * wb)
      ctx.lineTo(b.x - nx * wb, b.y - ny * wb)
      ctx.lineTo(a.x - nx * wa, a.y - ny * wa)
      ctx.closePath()
      ctx.fill()
    }
    ctx.save()
    ctx.globalAlpha = (aim.mine ? 1 : 0.6) * alpha
    // Shadow first, then tip, ferrule, shaft, wrap and butt.
    ctx.translate(3 * s + 1, 5 * s + 1)
    section(0, 460, 5, 11, 'rgba(0, 0, 0, 0.28)')
    ctx.translate(-(3 * s + 1), -(5 * s + 1))
    section(0, 5, 4.6, 4.8, '#3d6fb0')
    section(5, 20, 4.8, 5.2, '#f1ead8')
    section(20, 270, 5.2, 8.6, '#d9b77a')
    section(270, 290, 8.6, 8.9, '#2a2420')
    section(290, 400, 8.9, 10.2, '#4a1f18')
    section(400, 455, 10.2, 11, '#1c1614')
    section(455, 460, 11, 10.4, '#c9a45c')
    // A highlight along the shaft.
    ctx.globalAlpha *= 0.35
    section(22, 268, 1.2, 2, '#fff6e0')
    ctx.restore()
  }

  PoolTable.prototype.drawStrike = function (strike, now) {
    const age = now - strike.at
    const advance = Math.min(1, age / 70)
    const alpha = age < 110 ? 1 : Math.max(0, 1 - (age - 110) / 200)
    this.drawCue({x: strike.x, y: strike.y, dx: strike.dx, dy: strike.dy, power: strike.power, mine: true}, advance, alpha)
  }

  PoolTable.prototype.drawPlacement = function (place, now) {
    const ctx = this.ctx
    const at = this.toScreen(place.x, place.y)
    const pulse = 0.5 + 0.5 * Math.sin(now / 260)
    ctx.save()
    ctx.strokeStyle = place.legal ? 'rgba(123, 224, 165, ' + (0.55 + 0.4 * pulse) + ')' : '#ff6b76'
    ctx.lineWidth = 2
    ctx.setLineDash([5, 4])
    ctx.beginPath()
    ctx.arc(at.x, at.y, R * this.scale + 4 + pulse * 2, 0, TAU)
    ctx.stroke()
    ctx.restore()
  }

  // ── Effects ───────────────────────────────────────────────────────────────

  PoolTable.prototype.drawRing = function (ring, now) {
    const ctx = this.ctx
    const age = (now - ring.at) / 260
    const at = this.toScreen(ring.x, ring.y)
    ctx.save()
    ctx.strokeStyle = 'rgba(255, 255, 255, ' + 0.5 * ring.strength * (1 - age) + ')'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.arc(at.x, at.y, (4 + 22 * age * (0.5 + ring.strength)) * this.scale, 0, TAU)
    ctx.stroke()
    ctx.restore()
  }

  // A potted ball slides into its pocket, shrinking and darkening.
  PoolTable.prototype.drawSink = function (sink, now, radius) {
    const age = Math.min(1, (now - sink.at) / 320)
    const ease = 1 - (1 - age) * (1 - age)
    const corner = sink.px === 0 || sink.px === W
    const px = corner ? sink.px + (sink.px === 0 ? -9 : 9) : sink.px
    const py = corner ? sink.py + (sink.py === 0 ? -9 : 9) : sink.py < 0 ? -15 : H + 15
    const at = this.toScreen(sink.x + (px - sink.x) * ease, sink.y + (py - sink.y) * ease)
    this.drawBall(sink.id, at.x, at.y, radius * (1 - 0.35 * ease), sink.m, 1 - ease)
  }

  PoolTable.prototype.drawConfetti = function (piece, now) {
    const ctx = this.ctx
    const age = (now - piece.at) / 1000
    const at = this.toScreen(piece.x + piece.vx * age, piece.y + piece.vy * age + 160 * age * age)
    ctx.save()
    ctx.globalAlpha = Math.max(0, 1 - age / 2.6)
    ctx.translate(at.x, at.y)
    ctx.rotate(piece.turn * age)
    ctx.fillStyle = piece.color
    ctx.fillRect((-piece.size * this.scale) / 2, (-piece.size * this.scale) / 4, piece.size * this.scale, (piece.size * this.scale) / 2)
    ctx.restore()
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + w, y, x + w, y + h, r)
    ctx.arcTo(x + w, y + h, x, y + h, r)
    ctx.arcTo(x, y + h, x, y, r)
    ctx.arcTo(x, y, x + w, y, r)
    ctx.closePath()
  }

  function diamond(ctx, x, y, size) {
    ctx.beginPath()
    ctx.moveTo(x, y - size)
    ctx.lineTo(x + size * 0.7, y)
    ctx.lineTo(x, y + size)
    ctx.lineTo(x - size * 0.7, y)
    ctx.closePath()
    ctx.fill()
  }

  function normalize(v) {
    const length = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
    return [v[0] / length, v[1] / length, v[2] / length]
  }

  // A fixed sequence, so the grain and the cloth look the same every time.
  function generator(seed) {
    let a = seed
    return function () {
      a = (Math.imul(a, 1103515245) + 12345) >>> 0
      return a / 4294967296
    }
  }

  root.PoolTable = PoolTable
})(window)
