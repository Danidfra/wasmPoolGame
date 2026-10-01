// LN Pool public page controller: the hall lobby and the match table.
//
// The backend is the only source of truth for seats, turn order, the agreed
// table and money. This file talks to it, simulates shots locally and reports
// what it computed. Websocket messages are treated as hints to refetch (or,
// for the opponent's aim, as decoration) because anyone can publish on a
// channel.
//
// What the page looks like lives elsewhere: play-ui.js puts state on the page,
// pool-table.js draws the table, pool-fx.js adds rotation, effects and sound.
// None of them can change the game.
;(function () {
  'use strict'

  const bridge = window.createLnbitsBridge('lnpool')
  const E = window.PoolEngine
  const V = window.PoolView
  const UI = window.PoolUI
  const fx = new window.PoolFx()
  const origin = new URL(window.location.href).origin

  const SYNC_MS = 5000
  const AIM_SEND_MS = 150
  const MAX_STEPS_PER_FRAME = 48
  const NAME_KEY = 'lnpool.name'
  const STAKE_KEY = 'lnpool.stake'
  const SOUND_KEY = 'lnpool.sound'
  const PLAYED = ['active', 'finished', 'disputed', 'resolved']

  const app = {
    hallId: '',
    matchId: '',
    creds: null, // {playerId, token, paymentRequest}
    view: null,
    snap: null, // what was last announced, for telling what changed
    channel: null,
    syncing: false,
    syncAgain: false,
    failures: 0,
    ticks: 0,
    started: false,
    lobbyLoaded: false,
    prefill: {name: '', stake: ''},
    claimTries: 0,
    claimTimer: 0,
    claimDestination: '',
    concedeArmed: false,
    muted: false
  }

  // The local picture of the table. `table` is the agreed state at `seq`;
  // `sim` is a shot being (or just finished being) played on top of it.
  const game = {
    seq: -1,
    table: null,
    sim: null,
    simSeq: -1,
    shotJson: '',
    result: null,
    resultAt: 0,
    next: null,
    acc: 0,
    reporting: false,
    shooting: false,
    outdated: false,
    aim: {dx: -1, dy: 0},
    power: 55,
    place: null,
    placePreview: null,
    dragging: '',
    remoteAim: null,
    lastAimSent: '',
    lastAimAt: 0
  }

  let table = null
  let lastFrame = 0

  UI.init({
    create: createMatch,
    openMatch: id => goTo('/ext/lnpool/matches/' + encodeURIComponent(id)),
    join: joinMatch,
    cancel: cancelMatch,
    claim: destination => claim(destination, true),
    concede,
    shoot,
    nudge: rotateAim,
    power: setPower,
    copy,
    copyKey: () => copy(app.creds.playerId + ':' + app.creds.token, 'Seat key copied. Keep it private.'),
    restore: restoreSeat,
    toggleSound,
    lobby: toLobby,
    again: newGame,
    retry: start
  })
  start()

  async function start() {
    UI.page('loading')
    try {
      const context = await bridge.context()
      app.hallId = String((context.routeParams && context.routeParams.hallId) || '')
      app.matchId = String((context.routeParams && context.routeParams.matchId) || '')
      app.prefill.name = await bridge.getSession(NAME_KEY).catch(() => '')
      app.prefill.stake = await bridge.getSession(STAKE_KEY).catch(() => '')
      app.muted = (await bridge.getSession(SOUND_KEY).catch(() => '')) === 'off'
      fx.setMuted(app.muted)
      UI.sound(!app.muted)
      if (app.matchId) await showMatch()
      else if (app.hallId) await showLobby()
      else UI.fatal('Nothing here', 'This link does not point to a hall or a match.', false)
    } catch (error) {
      UI.fatal('LN Pool could not start', friendly(error))
    }
  }

  // ── Lobby ─────────────────────────────────────────────────────────────────

  async function showLobby() {
    await refreshLobby()
    if (app.started) return
    app.started = true
    window.setInterval(refreshLobby, 10000)
  }

  async function refreshLobby() {
    try {
      UI.lobby(await bridge.api('GET', '/halls/' + encodeURIComponent(app.hallId)), app.prefill)
      app.lobbyLoaded = true
    } catch (error) {
      if (app.lobbyLoaded) UI.toast(friendly(error), 'bad')
      else UI.fatal('This hall is not available', friendly(error))
    }
  }

  async function createMatch({name, stake}) {
    UI.busy('create-button', true)
    try {
      const data = await bridge.api('POST', '/halls/' + encodeURIComponent(app.hallId) + '/matches', {name, stake})
      await bridge.setSession(NAME_KEY, name).catch(() => {})
      await bridge.setSession(STAKE_KEY, String(stake)).catch(() => {})
      await saveCreds(data.match.id, {playerId: data.playerId, token: data.token, paymentRequest: data.paymentRequest})
      await goTo('/ext/lnpool/matches/' + encodeURIComponent(data.match.id))
    } catch (error) {
      UI.toast(friendly(error), 'bad')
      UI.busy('create-button', false)
    }
  }

  // ── Match ─────────────────────────────────────────────────────────────────

  async function showMatch() {
    app.creds = await loadCreds(app.matchId)
    if (!app.started) {
      app.started = true
      if (app.prefill.name) document.getElementById('join-name').value = app.prefill.name
      table = new window.PoolTable(document.getElementById('table'))
      table.sponsor = UI.tableSponsor()
      bindTable()
      window.setInterval(tick, SYNC_MS)
      // The "syncing" line depends on how long we have waited; keep it current.
      window.setInterval(() => {
        if (game.result && app.view && app.view.status === 'active') render()
      }, 1000)
      window.addEventListener('resize', layout)
      if (window.ResizeObserver) new ResizeObserver(layout).observe(document.getElementById('table'))
      window.requestAnimationFrame(frame)
    }
    await sync()
    if (!app.view) return
    connectChannel()
  }

  function layout() {
    table.setVertical(UI.portrait())
    table.resize()
  }

  function matchPath(suffix) {
    return '/matches/' + encodeURIComponent(app.matchId) + (suffix || '')
  }

  function withCreds(body) {
    return {playerId: app.creds.playerId, token: app.creds.token, ...(body || {})}
  }

  async function sync() {
    if (app.syncing) {
      app.syncAgain = true
      return
    }
    app.syncing = true
    try {
      let data
      if (app.creds) {
        try {
          data = await bridge.api('POST', matchPath('/sync'), withCreds())
        } catch (error) {
          if (!/seat key/i.test(error.message)) throw error
          // The stored key does not belong to this match. Carry on as a spectator.
          app.creds = null
          data = await bridge.api('GET', matchPath())
        }
      } else {
        data = await bridge.api('GET', matchPath())
      }
      app.failures = 0
      UI.live('live')
      applyView(data.match)
    } catch (error) {
      app.failures += 1
      if (!app.view) UI.fatal('This match is not available', friendly(error))
      else if (app.failures >= 2) UI.live('retrying')
    } finally {
      app.syncing = false
      if (app.syncAgain) {
        app.syncAgain = false
        sync()
      }
    }
  }

  function tick() {
    app.ticks += 1
    const view = app.view
    const live = !view || view.status === 'open' || view.status === 'active' || ['paying', 'pending'].includes(view.settlement.status)
    if (live || app.ticks % 3 === 0) sync()
    // A socket can close without telling us; renew it now and then.
    if (!app.channel || app.ticks % 24 === 0) connectChannel()
    // A hidden tab gets no animation frames. Finish the shot anyway so the
    // opponent is not left waiting for this side's report.
    if (document.hidden) finishHidden()
  }

  function finishHidden() {
    if (!game.sim || game.sim.done) return
    while (!game.sim.done) E.stepShot(game.sim)
    finishSim()
  }

  async function connectChannel() {
    const previous = app.channel
    app.channel = null
    if (previous) previous.close()
    try {
      app.channel = await bridge.subscribe(app.matchId, onChannelMessage, () => {
        app.channel = null
      })
    } catch (_error) {
      app.channel = null
    }
  }

  function onChannelMessage(message) {
    if (!message || typeof message !== 'object') return
    if (message.t === 'sync') {
      sync()
    } else if (message.t === 'aim' && message.seq === game.seq && !canAim()) {
      const aim = {dx: Number(message.dx), dy: Number(message.dy), power: Number(message.power), place: null}
      if (![aim.dx, aim.dy, aim.power].every(Number.isFinite)) return
      if (Array.isArray(message.place) && message.place.length === 2 && message.place.every(Number.isFinite)) {
        aim.place = {x: message.place[0], y: message.place[1]}
      }
      game.remoteAim = aim
    }
  }

  function applyView(view) {
    app.view = view
    updateGame(view)
    render()
    keepClaiming(view)
  }

  // ── Local game state ──────────────────────────────────────────────────────

  function updateGame(view) {
    if (!PLAYED.includes(view.status)) return
    const agreed = view.game || E.initialState(view.id)
    // A table made by another version of the engine cannot be continued from
    // here: this browser would compute different results and freeze the match.
    game.outdated = agreed.engine !== E.VERSION
    if (game.seq !== view.seq) {
      // Let a shot that is still rolling finish before jumping to its result.
      if (game.sim && !game.sim.done && game.simSeq === view.seq - 1) game.next = {seq: view.seq, table: agreed}
      else adopt(view.seq, agreed)
    }
    const pending = view.shot
    if (view.status === 'active' && !game.outdated && pending && pending.seq === view.seq && game.seq === view.seq) {
      // The recorded shot is the one that counts, even over our own.
      if (game.simSeq !== view.seq || game.shotJson !== JSON.stringify(pending.shot)) {
        beginSim(pending.shot)
        // Nobody is watching a hidden tab: work the shot out now rather than
        // keep the other player waiting for this side's report.
        if (document.hidden) finishHidden()
      }
    }
    maybeReport()
  }

  function adopt(seq, agreed) {
    game.seq = seq
    game.table = agreed
    game.sim = null
    game.simSeq = -1
    game.shotJson = ''
    game.result = null
    game.resultAt = 0
    game.next = null
    game.place = null
    game.placePreview = null
    game.remoteAim = null
    game.dragging = ''
    fx.settle()
  }

  function beginSim(shot) {
    game.sim = E.startShot(game.table, shot)
    game.simSeq = game.seq
    game.shotJson = JSON.stringify(shot)
    game.result = null
    game.resultAt = 0
    game.acc = 0
    game.remoteAim = null
    fx.shotStarted(game.sim, performance.now())
  }

  function finishSim() {
    game.result = E.finishShot(game.table, game.sim)
    game.resultAt = performance.now()
    if (game.next) adopt(game.next.seq, game.next.table)
    else maybeReport()
    render()
  }

  // Tell the backend what this browser computed for the recorded shot. The
  // turn is committed only when both players report the same table.
  function maybeReport() {
    const view = app.view
    if (!game.result || game.reporting || !app.creds || !view || !view.you || !view.you.seat) return
    if (view.status !== 'active' || view.seq !== game.simSeq) return
    if (!view.shot || view.shot.seq !== game.simSeq || JSON.stringify(view.shot.shot) !== game.shotJson) return
    if (view.you.resultSeq === game.simSeq) return
    game.reporting = true
    bridge
      .api('POST', matchPath('/result'), withCreds({seq: game.simSeq, result: game.result}))
      .then(data => {
        game.reporting = false
        applyView(data.match)
      })
      .catch(error => {
        game.reporting = false
        UI.toast(friendly(error), 'bad')
      })
  }

  function canAim() {
    const view = app.view
    return !!(
      view &&
      view.status === 'active' &&
      view.you &&
      view.you.seat === view.turn &&
      !view.shot &&
      !game.sim &&
      !game.shooting &&
      !game.outdated &&
      game.table &&
      game.seq === view.seq
    )
  }

  function cuePosition() {
    if (game.table.inHand && game.place) return game.place
    const at = game.table.balls[0]
    return {x: at[0], y: at[1]}
  }

  function shoot() {
    if (!canAim()) return
    const place = game.table.inHand && game.place ? [game.place.x, game.place.y] : null
    const shot = {dx: game.aim.dx, dy: game.aim.dy, power: game.power, place}
    // Play it at once; the backend only has to record it, not approve each frame.
    beginSim(shot)
    game.shooting = true
    render()
    bridge
      .api('POST', matchPath('/shot'), withCreds({seq: game.seq, shot}))
      .then(data => {
        game.shooting = false
        applyView(data.match)
      })
      .catch(error => {
        game.shooting = false
        if (game.simSeq === game.seq) {
          game.sim = null
          game.simSeq = -1
          game.result = null
          game.resultAt = 0
        }
        UI.toast(friendly(error), 'bad')
        sync()
      })
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  function bindTable() {
    const canvas = document.getElementById('table')
    canvas.addEventListener('pointerdown', event => {
      if (!canAim()) return
      canvas.setPointerCapture(event.pointerId)
      const point = table.toTable(event)
      const cue = cuePosition()
      const nearCue = distance(point, cue) < E.BALL_RADIUS * 2.6
      game.dragging = game.table.inHand && nearCue ? 'cue' : 'aim'
      pointerTo(point)
    })
    canvas.addEventListener('pointermove', event => {
      // Aim by clicking or dragging, never by hovering: the pointer has to
      // cross the table to reach the Shoot button without moving the cue.
      if (canAim() && game.dragging) pointerTo(table.toTable(event))
    })
    const release = () => {
      game.dragging = ''
      game.placePreview = null
    }
    canvas.addEventListener('pointerup', release)
    canvas.addEventListener('pointercancel', release)

    window.addEventListener('keydown', event => {
      if (!canAim() || ['INPUT', 'TEXTAREA'].includes(event.target.tagName) && event.target.type !== 'range') return
      const fine = event.shiftKey ? 1 : 0.2
      if (event.key === 'ArrowLeft') rotateAim(-fine)
      else if (event.key === 'ArrowRight') rotateAim(fine)
      else if (event.key === 'ArrowUp') setPower(game.power + 1)
      else if (event.key === 'ArrowDown') setPower(game.power - 1)
      else if (event.key === ' ' || event.key === 'Enter') shoot()
      else return
      event.preventDefault()
    })
    // Browsers only allow sound after the player has touched the page.
    window.addEventListener('pointerdown', () => fx.unlock())
    window.addEventListener('keydown', () => fx.unlock())
  }

  function pointerTo(point) {
    if (game.dragging === 'cue') {
      const x = snap(clamp(point.x, E.BALL_RADIUS, E.TABLE.WIDTH - E.BALL_RADIUS))
      const y = snap(clamp(point.y, E.BALL_RADIUS, E.TABLE.HEIGHT - E.BALL_RADIUS))
      const legal = E.isLegalCuePosition(game.table, x, y)
      if (legal) game.place = {x, y}
      game.placePreview = {x, y, legal}
      return
    }
    const cue = cuePosition()
    const dx = point.x - cue.x
    const dy = point.y - cue.y
    const length = Math.sqrt(dx * dx + dy * dy)
    if (length > E.BALL_RADIUS / 2) game.aim = {dx: dx / length, dy: dy / length}
  }

  function rotateAim(degrees) {
    if (!canAim()) return
    const angle = (degrees * Math.PI) / 180
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    const dx = game.aim.dx * cos - game.aim.dy * sin
    const dy = game.aim.dx * sin + game.aim.dy * cos
    const length = Math.sqrt(dx * dx + dy * dy)
    game.aim = {dx: dx / length, dy: dy / length}
  }

  function setPower(value) {
    game.power = clamp(Math.round(value), E.MIN_POWER, E.MAX_POWER)
    UI.power(game.power)
  }

  // Let the opponent watch the cue move. Decoration only: the shot that
  // counts is the one recorded by the backend.
  function shareAim(now) {
    if (!app.channel || !canAim() || now - game.lastAimAt < AIM_SEND_MS) return
    const place = game.table.inHand && game.place ? [game.place.x, game.place.y] : null
    const message = {t: 'aim', seq: game.seq, dx: game.aim.dx, dy: game.aim.dy, power: game.power, place}
    const json = JSON.stringify(message)
    if (json === game.lastAimSent) return
    game.lastAimSent = json
    game.lastAimAt = now
    app.channel.send(message).catch(() => {})
  }

  // ── Drawing ───────────────────────────────────────────────────────────────

  function frame(now) {
    window.requestAnimationFrame(frame)
    const elapsed = Math.min(0.1, (now - (lastFrame || now)) / 1000)
    lastFrame = now
    if (game.sim && !game.sim.done) {
      game.acc += elapsed
      let steps = Math.min(MAX_STEPS_PER_FRAME, Math.floor(game.acc / E.DT))
      game.acc -= steps * E.DT
      while (steps > 0 && !game.sim.done) {
        E.stepShot(game.sim)
        fx.afterStep(game.sim, now)
        steps -= 1
      }
      if (game.sim.done) finishSim()
    }
    if (!game.table || document.getElementById('arena').hidden) return
    if (!table.width) layout()
    shareAim(now)
    table.draw(scene(now))
  }

  function scene(now) {
    let balls
    if (game.sim && !game.result) {
      // Between two engine steps, draw each ball a fraction of a step ahead
      // so motion is smooth at any refresh rate. The simulation is untouched.
      const lead = Math.min(game.acc, E.DT)
      balls = game.sim.balls.filter(ball => ball.on).map(ball => ({id: ball.id, x: ball.x + ball.vx * lead, y: ball.y + ball.vy * lead}))
    } else {
      const shown = game.result || game.table
      balls = []
      shown.balls.forEach((at, id) => {
        if (at) balls.push({id, x: at[0], y: at[1]})
      })
    }
    const drawn = {balls, aim: null, ghost: null, place: null, fx: fx.live(now), now}
    const view = app.view
    const mine = canAim()
    const theirs = !mine && view && view.status === 'active' && !view.shot && !game.sim && game.remoteAim
    if (mine || theirs) {
      const aim = mine ? {dx: game.aim.dx, dy: game.aim.dy, power: game.power} : game.remoteAim
      const cue = mine ? cuePosition() : game.table.inHand && aim.place ? aim.place : {x: game.table.balls[0][0], y: game.table.balls[0][1]}
      const cueBall = balls.find(ball => ball.id === 0)
      if (cueBall) {
        cueBall.x = cue.x
        cueBall.y = cue.y
      }
      drawn.aim = {x: cue.x, y: cue.y, dx: aim.dx, dy: aim.dy, power: aim.power, mine}
      drawn.ghost = E.aimPreview(game.table, cue.x, cue.y, aim.dx, aim.dy)
      if (mine && game.table.inHand) drawn.place = game.placePreview || {x: cue.x, y: cue.y, legal: true}
    }
    fx.orient(balls, table.vertical)
    return drawn
  }

  // Hand the current state to the page, and say what changed since last time.
  function render() {
    const view = app.view
    if (!view) return
    const shown = PLAYED.includes(view.status) ? game.result || game.table : null
    const rolling = !!(game.sim && !game.result)
    const confirming = view.status === 'active' && !rolling && !!(game.result || view.shot)

    const snapshot = V.snapshot(view, shown)
    for (const event of V.events(app.snap, snapshot)) announce(event)
    app.snap = snapshot

    if (view.status !== 'active') app.concedeArmed = false
    UI.match({
      view,
      table: shown,
      flags: {
        canAim: canAim(),
        rolling,
        confirming,
        waitMs: confirming && game.resultAt ? performance.now() - game.resultAt : 0,
        outdated: game.outdated
      },
      invoice: (app.creds && app.creds.paymentRequest) || '',
      hasKey: !!app.creds,
      link: origin + '/ext/lnpool/matches/' + encodeURIComponent(view.id),
      concedeArmed: app.concedeArmed
    })
  }

  function announce(event) {
    if (event.where === 'callout') UI.callout(event)
    else UI.toast(event.text, event.tone)
    if (event.sound) fx.play(event.sound, 1)
    if (event.tone === 'win') fx.celebrate(performance.now())
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  async function joinMatch(name) {
    UI.busy('join-button', true)
    try {
      const data = await bridge.api('POST', matchPath('/join'), {name})
      await bridge.setSession(NAME_KEY, name).catch(() => {})
      app.creds = {playerId: data.playerId, token: data.token, paymentRequest: data.paymentRequest}
      await saveCreds(app.matchId, app.creds)
      await sync()
    } catch (error) {
      UI.toast(friendly(error), 'bad')
    }
    UI.busy('join-button', false)
  }

  async function cancelMatch() {
    try {
      applyView((await bridge.api('POST', matchPath('/cancel'), withCreds())).match)
    } catch (error) {
      UI.toast(friendly(error), 'bad')
    }
  }

  async function concede() {
    if (!app.concedeArmed) {
      app.concedeArmed = true
      render()
      return
    }
    try {
      applyView((await bridge.api('POST', matchPath('/concede'), withCreds())).match)
    } catch (error) {
      UI.toast(friendly(error), 'bad')
    }
  }

  async function claim(destination, byHand) {
    if (byHand) {
      app.claimTries = 0
      app.claimDestination = destination
    }
    UI.busy('claim-button', true)
    try {
      const data = await bridge.api('POST', matchPath('/claim'), withCreds({destination: app.claimDestination}))
      UI.busy('claim-button', false)
      applyView(data.match)
      // The first call only records the invoice; the next one pays it, with
      // the whole of LNbits' time limit for the payment.
      if (data.bound) return claim('', false)
      // Another request is settling this match right now; look again shortly.
      if (data.settling) window.setTimeout(() => claim('', false), 2500)
    } catch (error) {
      // A failed answer does not mean a failed payout: the request can die
      // after the payment was made. Look at what the match says before
      // telling the player anything went wrong.
      await sync()
      UI.busy('claim-button', false)
      const state = app.view ? app.view.settlement.status : ''
      if (byHand && !['paid', 'paying', 'pending'].includes(state)) UI.toast(friendly(error), 'bad')
    }
  }

  // While a payout to this player is in flight, ask again every few seconds:
  // the backend can only learn how the payment ended by retrying it.
  function keepClaiming(view) {
    const you = view.you ? view.you.seat : 0
    const sending = ['paying', 'pending'].includes(view.settlement.status)
    if (!you || view.settlement.seat !== you || !sending || app.claimTimer || app.claimTries >= 12) return
    app.claimTries += 1
    app.claimTimer = window.setTimeout(() => {
      app.claimTimer = 0
      claim('', false)
    }, 4000)
  }

  async function restoreSeat(key) {
    const parts = key.split(':')
    if (parts.length !== 2 || !/^[0-9a-f]{64}$/.test(parts[0]) || !/^[0-9a-f]{64}$/.test(parts[1])) {
      UI.toast('That is not a seat key.', 'bad')
      return
    }
    app.creds = {playerId: parts[0], token: parts[1], paymentRequest: ''}
    await sync()
    if (app.creds) {
      await saveCreds(app.matchId, app.creds)
      UI.toast('Seat restored.', 'good')
    } else {
      UI.toast('That seat key does not belong to this match.', 'bad')
    }
  }

  function toggleSound() {
    app.muted = !app.muted
    fx.setMuted(app.muted)
    fx.unlock()
    UI.sound(!app.muted)
    bridge.setSession(SOUND_KEY, app.muted ? 'off' : 'on').catch(() => {})
  }

  function toLobby() {
    const hallId = (app.view && app.view.hallId) || app.hallId
    if (hallId && !(app.hallId && !app.matchId)) goTo('/ext/lnpool/halls/' + encodeURIComponent(hallId))
  }

  // Back to the lobby with the same buy-in ready to go.
  async function newGame() {
    if (app.view) await bridge.setSession(STAKE_KEY, String(app.view.stake)).catch(() => {})
    toLobby()
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  // Host session keys allow only [A-Za-z0-9._:-]; match ids contain '_'.
  function credsKey(matchId) {
    return 'lnpool.m.' + matchId.replace(/_/g, '-')
  }

  async function loadCreds(matchId) {
    try {
      const creds = JSON.parse((await bridge.getSession(credsKey(matchId))) || 'null')
      return creds && creds.playerId && creds.token ? creds : null
    } catch (_error) {
      return null
    }
  }

  async function saveCreds(matchId, creds) {
    try {
      await bridge.setSession(credsKey(matchId), JSON.stringify(creds))
    } catch (_error) {
      // Too long for the host's session store: keep the key, drop the invoice.
      await bridge.setSession(credsKey(matchId), JSON.stringify({...creds, paymentRequest: ''})).catch(() => {})
    }
  }

  function goTo(path) {
    return bridge.navigate(path).catch(() => UI.toast('Open ' + origin + path + ' to continue.', 'info'))
  }

  async function copy(value, done) {
    try {
      await navigator.clipboard.writeText(value)
      UI.toast(done, 'good')
    } catch (_error) {
      UI.toast('Copying is blocked here. Select the text and copy it by hand.', 'bad')
    }
  }

  function friendly(error) {
    const message = String((error && error.message) || error)
    if (/owner-context route source/i.test(message)) return 'This hall or match does not exist.'
    if (/too many active invocations/i.test(message)) return 'The server is busy. Trying again.'
    if (/internal server error|exception id|fuel consumed|execution time limit/i.test(message)) {
      return 'The server could not finish that request. Please try again.'
    }
    return message
  }

  function distance(a, b) {
    return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y))
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value))
  }

  function snap(value) {
    return Math.round(value * 1024) / 1024
  }
})()
