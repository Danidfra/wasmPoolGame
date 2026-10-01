// LN Pool view logic: the presentation decisions that need no DOM.
//
// Pure functions over what the backend and the engine already report. Nothing
// here talks to the network, changes the table or decides anything about the
// game; it only turns state into words and numbers for the page to show.
;(function (root) {
  'use strict'

  const SOLIDS = 1
  const STRIPES = 2
  const GROUP_NAME = {1: 'solids', 2: 'stripes'}
  const GROUP_BALLS = {1: [1, 2, 3, 4, 5, 6, 7], 2: [9, 10, 11, 12, 13, 14, 15]}

  function sats(amount) {
    return Math.round(Number(amount) || 0).toLocaleString('en-US')
  }

  // Up to five round stakes inside the hall's limits, smallest first.
  function stakePresets(min, max) {
    const round = [100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000]
    const inside = round.filter(value => value >= min && value <= max)
    let picks = inside
    if (inside.length > 5) {
      picks = [0, 1, 2, 3, 4].map(index => inside[Math.round((index * (inside.length - 1)) / 4)])
    }
    if (!picks.length || picks[0] !== min) picks = [min].concat(picks)
    return picks.filter((value, index) => picks.indexOf(value) === index).slice(0, 5)
  }

  // The match note, unless it is a remark about a failed payout left there by
  // an earlier version: payout() below words those for the player.
  function matchNote(view) {
    return /^Payout failed: /.test(view.note || '') ? '' : view.note || ''
  }

  // How long "sending" may be shown without a fresh answer from the backend.
  const SENDING_SECONDS = 20
  const PENDING_SECONDS = 150

  // The payout state to show. The backend already stops saying "paying" once
  // a payment has had its time; this does the same on the page's own clock,
  // so that a page which gets no more answers cannot go on saying "sending".
  // `waited` is the seconds since this view arrived.
  function payoutStatus(view, waited) {
    // `refused` is what earlier versions called a payment that was not sent.
    const status = view.settlement.status === 'refused' ? 'unsent' : view.settlement.status
    const age = (Number(view.serverTime) || 0) - (Number(view.updatedAt) || 0) + (Number(waited) || 0)
    if (status === 'paying' && age > SENDING_SECONDS) return 'unconfirmed'
    if (status === 'pending' && age > PENDING_SECONDS) return 'unconfirmed'
    return status
  }

  // What the result screen offers and says about the payout.
  //   form  'destination' asks where to send it, 'retry' is a button only
  //         (the backend pays, or asks about, the invoice it already has),
  //         '' is no form
  function payout(view, payee, waited) {
    const state = payoutStatus(view, waited)
    const amount = sats(view.settlement.amount) + ' sats'
    const reason = String(view.settlement.detail || '').replace(/ ?Last check: .*$/, '').replace(/\.$/, '')
    const none = {form: '', button: '', line: '', tone: ''}
    const sending = state === 'paying' || state === 'pending'
    if (!payee) {
      if (view.status !== 'finished') return none
      if (state === 'paid') return {...none, line: 'Prize paid out', tone: 'paid'}
      return sending ? {...none, line: 'Prize on its way', tone: 'sending'} : none
    }
    if (sending) return {...none, line: 'Sending ' + amount, tone: 'sending'}
    if (state === 'paid') return {...none, line: amount + ' sent to your wallet', tone: 'paid'}
    if (state === 'manual') return {...none, line: 'This match has to be paid out by the hall operator.', tone: 'bad'}
    if (state === 'unsent') {
      const short = /reserve|insufficient balance/i.test(reason)
      return {
        form: 'retry',
        button: 'Try again',
        line: short
          ? 'Nothing was sent: the hall wallet does not hold enough for the payout and the Lightning routing-fee reserve. Your ' + amount +
            ' are safe. Ask the hall operator to top up the wallet, then try again.'
          : 'Nothing was sent' + (reason ? ' (' + reason + ')' : '') + '. Your ' + amount + ' are safe. Try again.',
        tone: 'bad'
      }
    }
    if (state === 'failed') {
      return {
        form: 'retry',
        button: 'Try the payment again',
        line: 'The payment did not go through' + (reason ? ' (' + reason + ')' : '') + '. Try again. If it keeps failing, ask the hall operator to pay you.',
        tone: 'bad'
      }
    }
    if (state === 'unconfirmed') {
      return {
        form: 'retry',
        button: 'Check the payment again',
        line: 'This payment could not be confirmed. Look in your wallet: it may have arrived. If it has not, check again, or ask the hall operator.',
        tone: 'bad'
      }
    }
    const claim = {form: 'destination', button: 'Claim ' + amount, line: '', tone: ''}
    if (state !== 'released') return claim
    return {...claim, line: 'That payment failed and will not be tried again. Claim again with a new invoice or another wallet.', tone: 'bad'}
  }

  function initial(name) {
    const text = String(name || '').trim()
    return text ? text[0].toUpperCase() : '?'
  }

  function groupKind(table, seat) {
    if (!table || !table.groups) return 0
    return (table.groups === 1) === (seat === 1) ? SOLIDS : STRIPES
  }

  // The balls a seat still has to pot, for the row of small balls in the HUD:
  // [{number, down}] for its group, or [] while the table is open.
  function groupBalls(table, seat) {
    const kind = groupKind(table, seat)
    if (!kind) return []
    return GROUP_BALLS[kind].map(number => ({number, down: !table.balls[number]}))
  }

  // The few facts announcements depend on. Comparing two snapshots says what
  // just happened.
  function snapshot(view, table) {
    const kinds = [groupKind(table, 1), groupKind(table, 2)]
    return {
      status: view.status,
      you: view.you ? view.you.seat : 0,
      youStatus: view.you ? view.you.status : '',
      names: view.seats.map(seat => seat.name),
      paid: view.seats.map(seat => seat.paid),
      turn: view.turn,
      winner: view.winner,
      note: view.note || '',
      payout: view.settlement.status,
      payee: view.settlement.seat,
      amount: view.settlement.amount,
      shots: table ? table.shots : 0,
      last: table ? table.last : null,
      next: table ? table.turn : view.turn,
      inHand: table ? table.inHand : false,
      kinds,
      left: kinds.map((kind, index) => (kind ? groupBalls(table, index + 1).filter(ball => !ball.down).length : -1)),
      eightUp: table ? !!table.balls[8] : true
    }
  }

  function list(numbers) {
    if (numbers.length <= 1) return 'the ' + numbers.join('')
    return 'the ' + numbers.slice(0, -1).join(', ') + ' and ' + numbers[numbers.length - 1]
  }

  // What to tell the player about the step from `before` to `after`.
  // Each item: {where: 'callout' | 'toast', tone, text, sub, sound}.
  function events(before, after) {
    if (!before || !after) return []
    const out = []
    const you = after.you
    const who = seat => (seat === you ? 'You' : after.names[seat - 1] || 'Opponent')
    const is = seat => (seat === you ? 'You are' : who(seat) + ' is')
    const other = seat => (seat === 1 ? 2 : 1)

    if (before.youStatus === 'pending' && after.youStatus === 'seated') {
      out.push({where: 'toast', tone: 'good', text: 'Payment received. Your seat is confirmed.', sound: 'paid'})
    }
    for (const seat of [1, 2]) {
      if (!before.paid[seat - 1] && after.paid[seat - 1] && seat !== you) {
        out.push({where: 'toast', tone: 'info', text: who(seat) + ' joined the table.', sound: 'join'})
      }
    }
    if (before.status === 'open' && after.status === 'active') {
      out.push({where: 'callout', tone: 'info', text: 'Game on', sub: who(after.turn) + (after.turn === you ? ' break.' : ' breaks.'), sound: 'start'})
    }

    const shot = after.shots > before.shots ? after.last : null
    if (shot && !shot.end) {
      const shooter = shot.seat
      const numbered = shot.potted.filter(number => number !== 0 && number !== 8)
      if (shot.foul) {
        const reason =
          shot.foul === 'scratch' ? 'Cue ball potted' : shot.foul === 'no-contact' ? 'No ball hit' : 'Wrong ball hit first'
        out.push({
          where: 'callout',
          tone: 'bad',
          text: 'Foul',
          sub: reason + '. Ball in hand for ' + (other(shooter) === you ? 'you' : who(other(shooter))) + '.',
          sound: 'foul'
        })
      } else if (numbered.length) {
        out.push({where: 'callout', tone: 'good', text: who(shooter) + ' potted ' + list(numbered), sub: '', sound: ''})
      } else if (after.next !== shooter) {
        out.push({where: 'callout', tone: 'info', text: after.next === you ? 'Your turn' : who(after.next) + "'s turn", sub: '', sound: after.next === you ? 'turn' : ''})
      }
      if (shot.potted.indexOf(8) !== -1 && after.eightUp) {
        out.push({where: 'callout', tone: 'info', text: '8-ball back on the spot', sub: 'Potting it on the break is not a loss.', sound: ''})
      }
      if (!before.kinds[0] && after.kinds[0]) {
        const mine = you ? after.kinds[you - 1] : 0
        out.push({
          where: 'callout',
          tone: 'info',
          text: mine ? 'You are ' + GROUP_NAME[mine] : who(shooter) + ' is ' + GROUP_NAME[after.kinds[shooter - 1]],
          sub: mine ? who(other(you)) + ' is ' + GROUP_NAME[after.kinds[other(you) - 1]] + '.' : '',
          sound: ''
        })
      }
      for (const seat of [1, 2]) {
        if (after.kinds[seat - 1] && after.left[seat - 1] === 0 && before.left[seat - 1] !== 0) {
          out.push({where: 'callout', tone: 'info', text: is(seat) + ' on the 8-ball', sub: '', sound: ''})
        }
      }
    }

    if (before.status !== 'finished' && after.status === 'finished') {
      const won = after.winner === you
      out.push({
        where: 'callout',
        tone: you ? (won ? 'win' : 'lose') : 'info',
        text: won ? 'You win!' : who(after.winner) + ' wins',
        sub: after.note,
        sound: you ? (won ? 'win' : 'lose') : ''
      })
    }
    if (before.status !== 'disputed' && after.status === 'disputed') {
      out.push({where: 'toast', tone: 'bad', text: 'The two results for the last shot did not match. The match is frozen.', sound: 'foul'})
    }
    if (before.status === 'open' && after.status === 'cancelled') {
      out.push({where: 'toast', tone: 'info', text: 'The match was cancelled.', sound: ''})
    }
    if (before.payout !== 'paid' && after.payout === 'paid' && after.payee === you && you) {
      out.push({where: 'toast', tone: 'good', text: sats(after.amount) + ' sats sent to your wallet.', sound: 'paid'})
    }
    return out
  }

  // One step of rolling: turn a ball's 3x3 orientation by the distance it
  // moved on the cloth. Drawing only; the simulation never sees it.
  function roll(matrix, dx, dy, radius) {
    const distance = Math.sqrt(dx * dx + dy * dy)
    if (!(distance > 1e-6)) return matrix
    const kx = -dy / distance
    const ky = dx / distance
    const angle = distance / radius
    const c = Math.cos(angle)
    const s = Math.sin(angle)
    const t = 1 - c
    const r = [c + kx * kx * t, kx * ky * t, ky * s, kx * ky * t, c + ky * ky * t, -kx * s, -ky * s, kx * s, c]
    const m = matrix
    return [
      r[0] * m[0] + r[1] * m[3] + r[2] * m[6],
      r[0] * m[1] + r[1] * m[4] + r[2] * m[7],
      r[0] * m[2] + r[1] * m[5] + r[2] * m[8],
      r[3] * m[0] + r[4] * m[3] + r[5] * m[6],
      r[3] * m[1] + r[4] * m[4] + r[5] * m[7],
      r[3] * m[2] + r[4] * m[5] + r[5] * m[8],
      r[6] * m[0] + r[7] * m[3] + r[8] * m[6],
      r[6] * m[1] + r[7] * m[4] + r[8] * m[7],
      r[6] * m[2] + r[7] * m[5] + r[8] * m[8]
    ]
  }

  root.PoolView = Object.freeze({
    SOLIDS,
    STRIPES,
    GROUP_NAME,
    sats,
    stakePresets,
    matchNote,
    payoutStatus,
    payout,
    initial,
    groupKind,
    groupBalls,
    snapshot,
    events,
    roll
  })
})(typeof globalThis !== 'undefined' ? globalThis : this)
