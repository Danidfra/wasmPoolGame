// LN Pool page presentation: everything that puts words and elements on the
// lobby and match pages.
//
// It is told what the state is and asked to show it. It makes no requests,
// holds no game state and decides nothing: buttons call the handlers the
// controller (play.js) passes to init().
;(function () {
  'use strict'

  const E = window.PoolEngine
  const V = window.PoolView
  const $ = id => document.getElementById(id)
  const CALLOUT_MS = 1900
  const TOAST_MS = 5200

  let on = {}
  const lobbyState = {hall: null, listKey: '', touched: false}
  const callouts = []
  let calloutBusy = false

  function init(handlers) {
    on = handlers
    click('brand', () => on.lobby())
    click('to-hall', () => on.lobby())
    click('result-lobby', () => on.lobby())
    click('again', () => on.again())
    click('fatal-retry', () => on.retry())
    click('sound', () => on.toggleSound())

    click('create-button', () => on.create({name: $('create-name').value.trim(), stake: Number($('create-stake').value)}))
    $('create-stake').addEventListener('input', () => {
      lobbyState.touched = true
      renderStake()
    })
    enter('create-name', 'create-button')
    enter('create-stake', 'create-button')

    click('join-button', () => on.join($('join-name').value.trim()))
    enter('join-name', 'join-button')
    click('cancel-button', () => on.cancel())
    click('claim-button', () => on.claim($('claim-destination').value.trim()))
    enter('claim-destination', 'claim-button')
    click('concede', () => on.concede())
    click('copy-invoice', () => on.copy($('invoice-text').value, 'Invoice copied.'))
    click('copy-link', () => on.copy($('share-link').value, 'Link copied. Send it to your opponent.'))
    click('copy-key', () => on.copyKey())
    click('restore-button', () => on.restore($('restore-key').value.trim()))

    click('shoot', () => on.shoot())
    click('nudge-left', () => on.nudge(-0.25))
    click('nudge-right', () => on.nudge(0.25))
    $('power').addEventListener('input', event => on.power(Number(event.target.value)))
    sponsors()
  }

  function click(id, handler) {
    $(id).addEventListener('click', handler)
  }

  // Forms cannot submit inside the LNbits frame, so Enter is wired by hand.
  function enter(inputId, buttonId) {
    $(inputId).addEventListener('keydown', event => {
      if (event.key === 'Enter' && !$(buttonId).disabled) $(buttonId).click()
    })
  }

  function show(target, visible) {
    const element = typeof target === 'string' ? $(target) : target
    element.toggleAttribute('hidden', !visible)
  }

  function text(id, value) {
    const element = $(id)
    if (element.textContent !== value) element.textContent = value
  }

  // ── Page states ───────────────────────────────────────────────────────────

  function page(name) {
    for (const id of ['loading', 'fatal', 'lobby', 'match']) show(id, id === name)
    show('to-hall', name === 'match')
    show('sound', name === 'match')
  }

  function fatal(title, message, canRetry) {
    text('fatal-title', title)
    text('fatal-text', message)
    show('fatal-retry', canRetry !== false)
    page('fatal')
  }

  // ── Lobby ─────────────────────────────────────────────────────────────────

  function lobby(data, prefill) {
    const hall = data.hall
    const first = !lobbyState.hall
    lobbyState.hall = hall
    page('lobby')
    show('hall-closed', !hall.enabled)
    show('create-form', hall.enabled)

    if (first) {
      if (prefill.name) $('create-name').value = prefill.name
      const stake = $('create-stake')
      stake.min = hall.minStake
      stake.max = hall.maxStake
      const wanted = Number(prefill.stake)
      stake.value = wanted >= hall.minStake && wanted <= hall.maxStake ? wanted : V.stakePresets(hall.minStake, hall.maxStake)[0]
      const presets = $('stake-presets')
      presets.replaceChildren()
      for (const value of V.stakePresets(hall.minStake, hall.maxStake)) {
        const chip = document.createElement('button')
        chip.className = 'chip'
        chip.dataset.value = String(value)
        chip.textContent = V.sats(value)
        chip.addEventListener('click', () => {
          stake.value = value
          renderStake()
        })
        presets.append(chip)
      }
      text('stake-range', 'From ' + V.sats(hall.minStake) + ' to ' + V.sats(hall.maxStake) + ' sats.')
    }
    renderStake()

    const key = JSON.stringify(data.matches)
    if (key === lobbyState.listKey) return
    lobbyState.listKey = key
    const list = $('open-matches')
    list.replaceChildren()
    for (const match of data.matches) {
      const item = document.createElement('li')
      item.className = 'game'
      const avatar = element('span', 'avatar', V.initial(match.host))
      const who = element('div', 'game-who')
      who.append(element('strong', '', match.host), element('span', 'muted small', 'is waiting for an opponent'))
      const stakes = element('div', 'game-stakes')
      stakes.append(element('strong', '', V.sats(match.stake) + ' sats'), element('span', 'muted small', 'win ' + V.sats(match.prize)))
      const join = element('button', 'primary', 'Join')
      join.addEventListener('click', () => on.openMatch(match.id))
      item.append(avatar, who, stakes, join)
      list.append(item)
    }
    show('no-matches', data.matches.length === 0)
    show('open-count', data.matches.length > 0)
    text('open-count', String(data.matches.length))
  }

  function renderStake() {
    const hall = lobbyState.hall
    if (!hall) return
    const stake = Number($('create-stake').value)
    const valid = Number.isInteger(stake) && stake >= hall.minStake && stake <= hall.maxStake
    const prize = Math.floor((stake * 2 * (100 - hall.feePercent)) / 100)
    text('sum-pay', valid ? V.sats(stake) + ' sats' : '-')
    text('sum-win', valid ? V.sats(prize) + ' sats' : '-')
    show('sum-fee-row', hall.feePercent > 0)
    text('sum-fee', hall.feePercent + '% of the pot')
    $('stake-range').classList.toggle('bad', !valid && lobbyState.touched)
    $('create-button').disabled = !valid || !hall.enabled
    text('create-button', valid ? 'Create game · ' + V.sats(stake) + ' sats' : 'Create game')
    for (const chip of $('stake-presets').children) chip.classList.toggle('selected', Number(chip.dataset.value) === stake)
  }

  function busy(buttonId, isBusy) {
    const button = $(buttonId)
    button.classList.toggle('busy', isBusy)
    if (isBusy) button.disabled = true
    else if (buttonId !== 'create-button') button.disabled = false
    else renderStake()
  }

  // ── Match ─────────────────────────────────────────────────────────────────
  //
  // model: {
  //   view      the match as the backend reports it
  //   table     the table to show (the agreed one, or our result ahead of it)
  //   flags     {canAim, rolling, confirming, waitMs, outdated}
  //   invoice   our unpaid buy-in invoice, or ''
  //   hasKey    this tab holds a seat key
  //   link      the match link to share
  //   concedeArmed
  // }

  function match(model) {
    const view = model.view
    const table = model.table
    const you = view.you
    const seat = you ? you.seat : 0
    const status = view.status
    const open = status === 'open'
    const unseated = !!you && you.status === 'unseated'
    const names = [1, 2].map(n => view.seats[n - 1].name || (n === seat ? 'You' : 'Opponent'))
    page('match')

    // Players and pot.
    const turnSeat = status === 'active' ? (table ? table.turn : view.turn) : 0
    for (const info of view.seats) {
      const box = $('seat-' + info.seat)
      const kind = table && status !== 'open' ? V.groupKind(table, info.seat) : 0
      const balls = table && kind ? V.groupBalls(table, info.seat) : []
      const left = balls.filter(ball => !ball.down).length
      box.querySelector('.name').textContent = info.name || (open ? 'Open seat' : 'Empty seat')
      box.querySelector('.avatar').textContent = info.name ? V.initial(info.name) : '+'
      show(box.querySelector('.you-tag'), seat === info.seat)
      let sub = ''
      if (open) sub = info.paid ? 'Bought in' : 'Waiting for a player'
      else if (status === 'finished' && view.winner === info.seat) sub = 'Winner'
      else if (kind) sub = left === 0 ? 'On the 8-ball' : V.GROUP_NAME[kind][0].toUpperCase() + V.GROUP_NAME[kind].slice(1)
      else if (status === 'active') sub = 'Open table'
      box.querySelector('.player-sub').textContent = sub
      box.classList.toggle('is-open', !info.paid)
      box.classList.toggle('is-turn', turnSeat === info.seat && !model.flags.rolling)
      box.classList.toggle('is-winner', status === 'finished' && view.winner === info.seat)
      box.classList.toggle('is-loser', status === 'finished' && view.winner !== info.seat && info.paid)
      rack(box.querySelector('.rack'), balls, left)
    }
    text('pot-amount', V.sats(view.stake * 2) + ' sats')
    text('pot-sub', view.feePercent ? 'Winner gets ' + V.sats(view.prize) : V.sats(view.stake) + ' buy-in each')

    // Before the game.
    const pending = !!you && you.status === 'pending'
    const freeSeat = view.seats.some(info => !info.paid)
    const stage = !open || unseated ? '' : seat ? 'waiting' : pending && model.invoice ? 'pay' : pending ? 'closed' : !model.hasKey && freeSeat ? 'join' : 'closed'
    show('pregame', !!stage)
    for (const id of ['join', 'pay', 'waiting', 'closed']) show(id, stage === id)
    $('step-1').className = seat ? 'done' : 'now'
    $('step-2').className = seat ? 'now' : ''
    if (stage === 'join') {
      const host = view.seats.find(info => info.paid)
      text('join-title', host ? host.name + ' is waiting for an opponent' : 'Take a seat')
      text('join-text', 'Buy-in ' + V.sats(view.stake) + ' sats. The winner gets ' + V.sats(view.prize) + ' sats.')
      if (!$('join-button').classList.contains('busy')) text('join-button', 'Join for ' + V.sats(view.stake) + ' sats')
    } else if (stage === 'pay') {
      text('pay-title', 'Pay ' + V.sats(view.stake) + ' sats to take your seat')
      invoice(model.invoice)
    } else if (stage === 'waiting') {
      $('share-link').value = model.link
      show('cancel-button', seat === 1 && !view.seats[1].paid)
    } else if (stage === 'closed') {
      text('closed-title', pending ? 'Waiting for your payment' : 'This game is full')
      text('closed-text', pending ? 'Your seat is confirmed as soon as the buy-in arrives.' : 'Both seats are taken. You can watch once it starts.')
    }

    // The game.
    const playing = ['active', 'finished', 'disputed', 'resolved'].includes(status) && !!table
    show('arena', playing)
    show('turn', status === 'active')
    if (status === 'active') turn(model, seat, names, turnSeat)
    // The space under the table is kept while a match is in play, so the
    // table does not jump each time the controls come and go.
    show('dock', status === 'active' && seat > 0)
    show('controls', model.flags.canAim)
    text(
      'hint',
      model.flags.canAim
        ? (table.inHand ? 'Ball in hand: drag the cue ball where you want it. ' : '') +
            'Drag on the table to aim. Arrow keys fine-tune, Space shoots.'
        : ''
    )

    result(model, seat, names, unseated)

    show('concede', status === 'active' && seat > 0)
    text('concede', model.concedeArmed ? 'Tap again to give up the match' : 'Concede')
    show('seat-key', true)
    show('own-key', model.hasKey)
    show('restore', !model.hasKey)
  }

  // The row of small balls a player still has to pot.
  function rack(box, balls, left) {
    const wanted = balls.length ? (left === 0 ? '8' : balls.map(ball => (ball.down ? '-' : '') + ball.number).join(' ')) : ''
    if (box.dataset.shown === wanted) return
    box.dataset.shown = wanted
    box.replaceChildren()
    if (!balls.length) return
    if (left === 0) {
      box.append(element('i', 'mini b8', ''))
      return
    }
    for (const ball of balls) {
      const dot = element('i', 'mini b' + (ball.number > 8 ? ball.number - 8 : ball.number), '')
      if (ball.number > 8) dot.classList.add('stripe')
      if (ball.down) dot.classList.add('down')
      box.append(dot)
    }
  }

  function turn(model, seat, names, turnSeat) {
    const flags = model.flags
    const table = model.table
    const box = $('turn')
    const tags = []
    let line = ''
    let tone = ''
    const opponent = names[(seat === 1 ? 2 : 1) - 1]
    if (flags.outdated) {
      line = 'This match was started with a different version of the game. Reload the page; if that does not help, ask the hall operator to settle it.'
      tone = 'bad'
    } else if (flags.rolling) {
      line = 'Shot in play'
      tone = 'quiet'
    } else if (flags.confirming && flags.waitMs >= 2500) {
      // The only place the two-player check surfaces, and only when it is slow.
      line = seat
        ? flags.waitMs < 15000
          ? 'Syncing with ' + opponent
          : 'Still waiting for ' + opponent + ' to confirm the shot. They may have lost their connection.'
        : 'Syncing'
      tone = flags.waitMs < 15000 ? 'quiet pulse' : 'warn'
    } else {
      const mine = seat === turnSeat
      line = mine ? 'Your shot' : names[turnSeat - 1] + (seat ? ' is at the table' : ' to shoot')
      tone = mine ? 'mine' : ''
      if (table.inHand) tags.push('Ball in hand')
      if (table.breaking) tags.push('Break')
      const kind = V.groupKind(table, turnSeat)
      if (kind && V.groupBalls(table, turnSeat).every(ball => ball.down)) tags.push('On the 8-ball')
    }
    text('turn-text', line)
    box.className = 'turn ' + tone
    const wanted = tags.join('|')
    const holder = $('turn-tags')
    if (holder.dataset.shown !== wanted) {
      holder.dataset.shown = wanted
      holder.replaceChildren(...tags.map(tag => element('span', 'tag', tag)))
    }
  }

  function result(model, seat, names, unseated) {
    const view = model.view
    const status = view.status
    const settlement = view.settlement
    const over = ['finished', 'cancelled', 'disputed', 'resolved'].includes(status)
    show('result', over || unseated)
    if (!over && !unseated) return
    const payee = seat > 0 && settlement.seat === seat && ['finished', 'cancelled'].includes(status)
    const amount = V.sats(settlement.amount) + ' sats'
    const box = $('result')
    let tone = ''
    let eyebrow = ''
    let title = ''
    let body = ''
    let showAmount = false

    if (unseated) {
      eyebrow = 'Payment arrived too late'
      title = 'Your seat was already taken'
      body = 'Your buy-in came in after the seat was taken or the match had closed. The hall operator has to send it back. Keep your seat key (below) as proof.'
      tone = 'warn'
    } else if (status === 'finished') {
      const winner = names[view.winner - 1]
      eyebrow = 'Match over'
      if (seat === view.winner) {
        title = 'You won!'
        tone = 'win'
        showAmount = true
        body = V.matchNote(view)
      } else {
        title = winner + ' won'
        tone = seat ? 'lose' : ''
        body = (V.matchNote(view) ? V.matchNote(view) + ' ' : '') + 'The pot of ' + V.sats(view.prize) + ' sats goes to ' + winner + '.'
      }
    } else if (status === 'cancelled') {
      eyebrow = 'Match cancelled'
      title = payee ? 'Get your buy-in back' : 'This match was cancelled'
      showAmount = payee
      body = payee ? '' : 'It was cancelled before an opponent joined.'
    } else if (status === 'disputed') {
      eyebrow = 'Match frozen'
      title = 'The results did not match'
      body = 'The two players reported different outcomes for the last shot, so nobody is paid automatically. The hall operator will review the shot and settle the pot.'
      tone = 'warn'
    } else {
      eyebrow = 'Match closed'
      title = 'Settled by the hall'
      body = V.matchNote(view) || 'The hall operator settled this match by hand.'
    }
    box.className = 'result ' + tone
    text('result-eyebrow', eyebrow)
    text('result-title', title)
    show('result-amount', showAmount)
    text('result-amount', (status === 'cancelled' ? '' : '+') + amount)
    text('result-text', body)
    show('result-text', !!body)

    // Payout: the claim form for whoever is owed, a status line for everyone.
    const payout = V.payout(view, payee, model.waited)
    show('claim-form', !!payout.form)
    // One gold button at a time: claiming comes before starting another game.
    $('again').classList.toggle('primary', !payout.form)
    show('claim-destination', payout.form === 'destination')
    text('claim-label', status === 'cancelled' ? 'Where should the refund go?' : 'Where should the sats go?')
    $('claim-destination').placeholder = 'you@example.com, or an invoice for exactly ' + amount
    if (payout.form && !$('claim-button').classList.contains('busy')) text('claim-button', payout.button)
    show('payout', !!payout.line)
    text('payout-text', payout.line)
    $('payout').className = 'payout ' + payout.tone
    $('payout-icon').className = payout.tone === 'paid' ? 'tick' : payout.tone === 'sending' ? 'spinner small' : 'cross'
  }

  function invoice(paymentRequest) {
    const image = $('invoice-qr')
    if (image.dataset.invoice === paymentRequest) return
    const code = window.qrcode(0, 'L')
    code.addData(paymentRequest.toUpperCase(), 'Alphanumeric')
    code.make()
    image.src = code.createDataURL(4, 8)
    image.dataset.invoice = paymentRequest
    $('invoice-text').value = paymentRequest
  }

  // ── Announcements ─────────────────────────────────────────────────────────

  // A large, short-lived line over the table: a foul, a pot, whose turn.
  function callout(event) {
    callouts.push(event)
    if (!calloutBusy) nextCallout()
  }

  function nextCallout() {
    const event = callouts.shift()
    const box = $('callout')
    if (!event) {
      calloutBusy = false
      show(box, false)
      return
    }
    calloutBusy = true
    text('callout-text', event.text)
    text('callout-sub', event.sub || '')
    box.className = 'callout ' + event.tone
    show(box, true)
    // Restart the CSS animation for this message.
    void box.offsetWidth
    box.classList.add('showing')
    window.setTimeout(nextCallout, callouts.length > 1 ? CALLOUT_MS * 0.7 : CALLOUT_MS)
  }

  // A small message in the corner: payments, joins, errors.
  function toast(message, tone) {
    const stack = $('toasts')
    for (const existing of stack.children) {
      if (existing.textContent === message) return
    }
    const item = element('p', 'toast ' + (tone || 'info'), message)
    stack.append(item)
    while (stack.children.length > 3) stack.firstChild.remove()
    window.setTimeout(() => {
      item.classList.add('leaving')
      window.setTimeout(() => item.remove(), 300)
    }, TOAST_MS)
  }

  function power(value) {
    $('power').value = value
    text('power-value', String(Math.round(value)))
  }

  function sound(enabled) {
    $('sound').setAttribute('aria-pressed', String(enabled))
    show('sound-on', enabled)
    show('sound-off', !enabled)
  }

  // 'live' | 'retrying' | '' (not in a match)
  function live(state) {
    show('live', !!state)
    $('live').className = 'live ' + state
    text('live-text', state === 'retrying' ? 'Reconnecting' : 'Live')
  }

  // Phones held upright get the table turned on its end.
  function portrait() {
    const upright = window.innerWidth < 640 && window.innerHeight > window.innerWidth * 1.15
    $('table-wrap').classList.toggle('vertical', upright)
    return upright
  }

  // ── Sponsor slots ─────────────────────────────────────────────────────────
  //
  // Places on the page reserved for a sponsor. They stay hidden unless
  // static/sponsors.js fills them in; nothing is fetched and nothing is
  // tracked. An image has to be a file shipped with the extension.

  function sponsors() {
    const config = window.LNPOOL_SPONSORS || {}
    for (const slot of document.querySelectorAll('[data-sponsor-slot]')) {
      const entry = config[slot.dataset.sponsorSlot]
      if (!entry || !entry.name) continue
      slot.replaceChildren(element('span', 'sponsor-label', entry.label || 'Sponsored by'))
      if (typeof entry.image === 'string' && entry.image.indexOf('/ext-assets/lnpool/') === 0) {
        const image = document.createElement('img')
        image.src = entry.image
        image.alt = ''
        slot.append(image)
      }
      slot.append(element('strong', '', String(entry.name).slice(0, 40)))
      if (entry.text) slot.append(element('span', 'sponsor-text', String(entry.text).slice(0, 80)))
      show(slot, true)
    }
  }

  function tableSponsor() {
    const config = window.LNPOOL_SPONSORS || {}
    return typeof config.table === 'string' ? config.table : ''
  }

  function element(tag, className, content) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (content) node.textContent = content
    return node
  }

  window.PoolUI = {init, page, fatal, lobby, busy, match, callout, toast, power, sound, live, portrait, tableSponsor}
})()
