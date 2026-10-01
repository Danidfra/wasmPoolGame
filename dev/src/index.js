import {lightning, storage, system, wallet, websocket} from './lnbits-sdk.js'

// LN Pool backend. It owns everything money depends on (seats, buy-ins, turn
// order, the agreed result, settlement) and nothing else: physics and rules
// run in the two browsers, and a turn only counts once both report the same
// table. See docs/DESIGN.md for the trust model.
//
// Storage is last-writer-wins with no compare-and-set, so every row below has
// as few writers as possible and nothing here relies on a read-check-write
// being atomic. The one step that must not happen twice at once, paying a
// match out, is guarded by `takeSettlementLock`: every call that pays a payout
// invoice is one recorded attempt, made by the one invocation holding that
// attempt's lock.

const HALLS = 'lnpool_halls'
const MATCHES = 'lnpool_matches'
const PLAYERS = 'lnpool_players'
const PAYOUTS = 'lnpool_payouts'

const LOCK_SATS = 1
const STAKE_FLOOR = 1
const STAKE_CEILING = 1000000
const MAX_FEE_PERCENT = 50
const JOIN_HOLD_SECONDS = 180
const MAX_JOIN_ATTEMPTS = 20
const LOBBY_SIZE = 50
const MAX_PAYOUT_ATTEMPTS = 30
// LNbits stops a call after wasm_runtime_max_execution_ms (5 s by default),
// time spent in host calls included, and itself waits up to 5 s for a
// Lightning payment. A call that has already used this much of its time does
// not take a settlement lock: a binding must not be cut off before it is
// recorded, and a payment should start with the whole deadline ahead of it.
const BIND_BUDGET_MS = 3500
const PAY_BUDGET_MS = 1000
// How long a payout attempt is left alone before the next claim looks into
// it. Only saves work: nothing about safety depends on these.
const SETTLING_SECONDS = 20
const RECHECK_SECONDS = 15
const MAX_STATE_BYTES = 4096
const HEX64 = /^[0-9a-f]{64}$/

// ── Hall owner (authenticated) ──────────────────────────────────────────────

export function getLnpoolHall(_requestJson) {
  return runJson(() => ({hall: hallView(ownerHall())}))
}

export function saveLnpoolHall(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const existing = ownerHall()
    const now = timeNow()
    const minStake = integerIn(request.minStake, existing.min_stake, STAKE_FLOOR, STAKE_CEILING)
    const hall = {
      id: existing.id || system.id('hall'),
      wallet_id: cleanText(request.walletId, 128),
      wallet_name: cleanText(request.walletName, 120),
      enabled: request.enabled === true,
      fee_percent: integerIn(request.feePercent, existing.fee_percent, 0, MAX_FEE_PERCENT),
      min_stake: minStake,
      max_stake: integerIn(request.maxStake, existing.max_stake, minStake, STAKE_CEILING),
      created_at: existing.created_at || now,
      updated_at: now
    }
    if (hall.enabled && !hall.wallet_id) throw new Error('Choose a wallet before opening the hall.')
    if (hall.wallet_id && !wallet.listUserWallets().some(item => item.id === hall.wallet_id)) {
      throw new Error('That wallet is not one of yours.')
    }
    storage.set(HALLS, hall)
    return {hall: hallView(hall)}
  })
}

export function listLnpoolWallets(_requestJson) {
  return runJson(() => ({wallets: wallet.listUserWallets()}))
}

export function listLnpoolMatches(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const limit = integerIn(request.rowsPerPage, 20, 1, 100)
    const page = integerIn(request.page, 1, 1, 1000000)
    const status = cleanText(request.status, 20)
    const found = storage.find(MATCHES, {
      filters: status ? {status} : {},
      sortBy: 'updated_at',
      descending: true,
      limit,
      offset: (page - 1) * limit
    })
    // Buy-ins that were paid but never got a seat. Nothing refunds these
    // automatically; the operator has to.
    const unseated = storage.find(PLAYERS, {filters: {status: 'unseated'}, sortBy: 'created_at', descending: true, limit: 50})
    return {
      matches: found.rows.map(adminMatchView),
      total: found.total,
      unseated: unseated.rows.map(player => adminPlayerView(player))
    }
  })
}

export function getLnpoolMatchAdmin(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const {match, players, seats} = loadMatch(request.matchId)
    return {
      match: adminMatchView(match),
      // Everything needed to re-run a contested shot offline: the table the
      // shot started from, the shot, and what each seat says it produced.
      evidence: {
        game: parseJson(match.game_json),
        shot: parseJson(match.shot_json),
        reports: [1, 2].map(seat => ({
          seat,
          seq: seats[seat] ? seats[seat].result_seq : -1,
          result: seats[seat] ? parseJson(seats[seat].result_json) : null
        }))
      },
      players: players.map(player => ({...adminPlayerView(player, seatOf(seats, player)), seat: seatOf(seats, player)})),
      // Every time a payout was tried, oldest first. This is what settlement
      // is decided on; the status in the match row is a copy of it.
      payouts: payoutAttempts(match.id).map(attempt => ({
        n: attempt.n,
        seat: attempt.seat,
        amount: attempt.amount,
        status: attempt.status,
        detail: attempt.detail,
        paymentHash: attempt.payment_hash,
        invoice: attempt.bolt11,
        at: attempt.updated_at
      }))
    }
  })
}

export function resolveLnpoolMatch(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const {match} = loadMatch(request.matchId)
    const resolved = storage.set(MATCHES, {
      ...match,
      status: 'resolved',
      note: cleanText(request.note, 300) || 'Settled manually by the hall operator.',
      updated_at: timeNow()
    })
    poke(resolved)
    return {match: adminMatchView(resolved)}
  })
}

// ── Players (public, run as the hall owner through ownerContext) ────────────

export function getPublicLnpoolHall(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const hall = requireHall(request.hallId)
    // Only matches somebody has already paid into: an unpaid match costs
    // nothing to create, so it must not show in the lobby or use up its page.
    const open = storage.find(MATCHES, {
      filters: {hall_id: hall.id, status: 'open', seated: 1},
      sortBy: 'created_at',
      descending: true,
      limit: LOBBY_SIZE
    })
    return {
      hall: {
        id: hall.id,
        enabled: hall.enabled === true,
        feePercent: hall.fee_percent,
        minStake: hall.min_stake,
        maxStake: hall.max_stake
      },
      matches: open.rows.map(match => ({
        id: match.id,
        stake: match.stake,
        prize: prizeAmount(match),
        host: match.p1_name,
        createdAt: match.created_at
      }))
    }
  })
}

export function createLnpoolMatch(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const hall = requireHall(request.hallId)
    if (hall.enabled !== true || !hall.wallet_id) throw new Error('This hall is closed.')
    const stake = Number(request.stake)
    if (!Number.isInteger(stake) || stake < hall.min_stake || stake > hall.max_stake) {
      throw new Error('The stake must be a whole number of sats from ' + hall.min_stake + ' to ' + hall.max_stake + '.')
    }
    const now = timeNow()
    const id = system.id('m')
    const draft = storage.set(MATCHES, {
      id,
      hall_id: hall.id,
      wallet_id: hall.wallet_id,
      stake,
      fee_percent: hall.fee_percent,
      status: 'open',
      seated: 0,
      p1_name: '',
      p2_name: '',
      seq: 0,
      turn: 1,
      game_json: '',
      shot_json: '',
      winner: 0,
      lock_bolt11: '',
      payout_seat: 0,
      payout_amount: 0,
      payout_bolt11: '',
      payout_hash: '',
      payout_status: '',
      note: '',
      created_at: now,
      updated_at: now
    })
    // The first settlement lock is created here: this call is the one moment
    // before a claim that cannot run twice.
    const match = storage.set(MATCHES, {...draft, lock_bolt11: settlementLockInvoice(id)})
    const seat = issueBuyIn(match, request.name)
    return {match: matchView(match, [], {}, null), ...seat}
  })
}

export function getPublicLnpoolMatch(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const {match, players, seats} = loadMatch(request.matchId)
    return {match: matchView(match, players, seats, null)}
  })
}

export function syncLnpoolMatch(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const {match, players, seats} = loadMatch(request.matchId)
    return {match: matchView(match, players, seats, authPlayer(match, players, seats, request, false))}
  })
}

export function joinLnpoolMatch(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const {match, players, seats} = loadMatch(request.matchId)
    if (match.status !== 'open') throw new Error('This match is not open for joining.')
    const free = 2 - match.seated
    const now = timeNow()
    // One outstanding invoice per free seat. An invoice cannot be cancelled,
    // so a slow payer can still arrive after their hold lapsed and find the
    // seat gone; that buy-in is then listed for a manual refund.
    const holding = players.filter(player => player.status === 'pending' && player.created_at > now - JOIN_HOLD_SECONDS)
    if (holding.length >= free) {
      throw new Error('Someone else is paying for this seat right now. Try again in a few minutes.')
    }
    if (players.length >= MAX_JOIN_ATTEMPTS) throw new Error('This match has had too many join attempts. Create a new one.')
    const seat = issueBuyIn(match, request.name)
    return {match: matchView(match, players, seats, null), ...seat}
  })
}

export function cancelLnpoolMatch(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const {match, players, seats} = loadMatch(request.matchId)
    const me = authPlayer(match, players, seats, request)
    if (match.status !== 'open' || me.seat !== 1 || seats[2]) {
      throw new Error('A match can only be cancelled by its first player before an opponent has paid.')
    }
    const cancelled = storage.set(MATCHES, {...match, status: 'cancelled', note: 'Cancelled before an opponent joined.', updated_at: timeNow()})
    poke(cancelled)
    return {match: matchView(cancelled, players, seats, me)}
  })
}

export function shootLnpoolMatch(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const {match, players, seats} = loadMatch(request.matchId)
    const me = authPlayer(match, players, seats, request)
    if (match.status !== 'active') throw new Error('This match is not being played.')
    if (me.seat !== match.turn) throw new Error('It is not your turn.')
    if (Number(request.seq) !== match.seq) throw new Error('The table has moved on. Reload it.')
    const pending = parseJson(match.shot_json)
    // The first shot recorded for a turn stands; a resend changes nothing.
    if (pending && pending.seq === match.seq) return {match: matchView(match, players, seats, me)}
    const shot = normalizeShot(request.shot)
    const updated = storage.set(MATCHES, {
      ...match,
      shot_json: JSON.stringify({seq: match.seq, seat: me.seat, shot}),
      updated_at: timeNow()
    })
    poke(updated)
    return {match: matchView(updated, players, seats, me)}
  })
}

export function reportLnpoolResult(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const {match, players, seats} = loadMatch(request.matchId)
    const me = authPlayer(match, players, seats, request)
    if (me.seat === 0) throw new Error('Only seated players report results.')
    const seq = Number(request.seq)
    // Already committed (or the match ended another way): nothing to report.
    if (match.status !== 'active' || seq !== match.seq) return {match: matchView(match, players, seats, me)}
    const pending = parseJson(match.shot_json)
    if (!pending || pending.seq !== seq) throw new Error('There is no shot to report on.')
    const result = normalizeResult(request.result)

    // Each player writes only their own row, then reads the other's. Whichever
    // of two simultaneous reports reads second is guaranteed to see both, so
    // at least one of them commits; if both do, they write the same thing.
    me.row = storage.set(PLAYERS, {...me.row, result_seq: seq, result_json: result.json})
    const other = storage.get(PLAYERS, seats[me.seat === 1 ? 2 : 1].id)
    if (!other || other.result_seq !== seq) return {match: matchView(match, players, seats, me)}

    const fresh = storage.get(MATCHES, match.id)
    if (!fresh || fresh.status !== 'active' || fresh.seq !== seq) {
      return {match: matchView(fresh || match, players, seats, me)}
    }
    const now = timeNow()
    const next = other.result_json === result.json
      ? {
          ...fresh,
          seq: seq + 1,
          turn: result.turn,
          game_json: result.json,
          shot_json: '',
          status: result.winner ? 'finished' : 'active',
          winner: result.winner,
          updated_at: now
        }
      : {
          ...fresh,
          status: 'disputed',
          note: 'The players reported different results for shot ' + (seq + 1) + '.',
          updated_at: now
        }
    storage.set(MATCHES, next)
    poke(next)
    return {match: matchView(next, players, seats, me)}
  })
}

export function concedeLnpoolMatch(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const {match, players, seats} = loadMatch(request.matchId)
    const me = authPlayer(match, players, seats, request)
    if (match.status !== 'active' || me.seat === 0) throw new Error('Only a seated player can concede a match in play.')
    const finished = storage.set(MATCHES, {
      ...match,
      status: 'finished',
      winner: me.seat === 1 ? 2 : 1,
      shot_json: '',
      note: (me.row.name || 'Seat ' + me.seat) + ' conceded.',
      updated_at: timeNow()
    })
    poke(finished)
    return {match: matchView(finished, players, seats, me)}
  })
}

export function claimLnpoolPayout(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const {match, players, seats} = loadMatch(request.matchId)
    const me = authPlayer(match, players, seats, request)
    const due = entitlement(match)
    if (!due || due.seat !== me.seat) throw new Error('There is nothing for this seat to claim.')
    if (match.payout_status === 'paid') return {match: matchView(match, players, seats, me)}
    if (match.payout_status === 'manual') throw new Error('This match has to be settled by the hall operator.')

    const attempts = payoutAttempts(match.id)
    // Bound by a version that kept the invoice in the match row.
    if (!attempts.length && match.payout_bolt11) return {match: matchView(payLegacyInvoice(match), players, seats, me)}

    const before = settlementOf(attempts)
    const last = before.last
    if (before.state === 'paid') return {match: matchView(recordSettlement(match, attempts), players, seats, me)}
    if (before.state === 'held') {
      const age = timeNow() - last.updated_at
      // Somebody is paying right now, or LNbits was asked a moment ago.
      if (last.status === 'started' && age < SETTLING_SECONDS) return {match: matchView(match, players, seats, me), settling: true}
      if (before.known.status === 'pending' && age < RECHECK_SECONDS) return {match: matchView(match, players, seats, me)}
    }
    if (attempts.length >= MAX_PAYOUT_ATTEMPTS) {
      throw new Error('This payout has been tried too many times. The hall operator has to settle it.')
    }

    // A payout takes two attempts, in two calls. The first binds: it resolves
    // and checks the destination, which can be slow, and records the invoice
    // without paying anything. The second pays, and does nothing slow before
    // the payment. While a payment of the bound invoice may exist, and once
    // an invoice is bound, that invoice is what the next attempt pays,
    // whatever the player typed.
    const paying = before.state === 'held' || (!!last && last.status === 'bound')
    const invoice = paying ? {bolt11: last.bolt11, paymentHash: last.payment_hash} : payoutInvoice(match, due, request.destination)
    // A binding makes the locks for the two attempts after it, so that the
    // paying attempt does not have to ask the node for an invoice first.
    const ahead = paying ? [] : [settlementLockInvoice(match.id), settlementLockInvoice(match.id)]
    const [lock, spare] = String(last ? last.next_lock : match.lock_bolt11).split(' ')
    if (elapsedMs() > (paying ? PAY_BUDGET_MS : BIND_BUDGET_MS)) {
      // Nothing has been taken or recorded. The page asks again.
      if (paying) return {match: matchView(match, players, seats, me), settling: true}
      throw new Error('That took too long to set up. Nothing was sent: claim again.')
    }
    const n = attempts.length + 1
    if (!takeSettlementLock(match, lock)) {
      // Another claim got there first.
      return {match: matchView(storage.get(MATCHES, match.id) || match, players, seats, me), settling: true}
    }

    // From here on this invocation is attempt n, and the only one there will
    // ever be. Look again: earlier attempts may have finished meanwhile.
    const fresh = storage.get(MATCHES, match.id)
    const earlier = payoutAttempts(match.id)
    const now = settlementOf(earlier)
    if (now.state === 'paid') return {match: matchView(recordSettlement(fresh || match, earlier), players, seats, me)}
    const stillDue = fresh ? entitlement(fresh) : null
    if (!stillDue || stillDue.seat !== due.seat || stillDue.amount !== due.amount || fresh.payout_status === 'manual' || earlier.length !== n - 1) {
      storage.set(MATCHES, {
        ...(fresh || match),
        payout_status: 'manual',
        note: 'The match changed while it was being settled. Settle it by hand.',
        updated_at: timeNow()
      })
      throw new Error('The match changed while it was being settled. The hall operator has to settle it.')
    }
    const createdAt = timeNow()
    const row = {
      id: match.id + '-' + n,
      match_id: match.id,
      n,
      seat: due.seat,
      amount: due.amount,
      detail: '',
      created_at: createdAt,
      updated_at: createdAt
    }

    if (!paying && now.state !== 'held') {
      const bound = storage.set(PAYOUTS, {
        ...row,
        bolt11: invoice.bolt11,
        payment_hash: invoice.paymentHash,
        status: 'bound',
        next_lock: ahead.join(' ')
      })
      const waiting = recordSettlement(fresh, [...earlier, bound])
      poke(waiting)
      // `bound` tells the page to claim again straight away: that call pays.
      return {match: matchView(waiting, players, seats, me), settling: true, bound: true}
    }

    const target = now.state === 'held' ? {bolt11: now.last.bolt11, paymentHash: now.last.payment_hash} : invoice
    // The lock for the attempt after this one has to exist before the payment
    // is made, so that a call cut off during the payment can be followed up.
    // After a binding it is already there.
    let nextLock = spare || ahead[0] || ''
    if (!nextLock) {
      try {
        nextLock = settlementLockInvoice(match.id)
      } catch (_error) {
        // Without it this is the last automatic attempt; it can still pay.
      }
    }
    const attempt = storage.set(PAYOUTS, {
      ...row,
      bolt11: target.bolt11,
      payment_hash: target.paymentHash,
      status: 'started',
      next_lock: nextLock
    })
    if (fresh.payout_status !== 'paying') recordSettlement(fresh, [...earlier, attempt])

    // The one call this attempt makes. If LNbits stops this invocation while
    // it runs, the payment still completes or fails on its own, nothing below
    // happens, and the row above stays `started`: a payment may exist.
    const outcome = payoutOutcome(wallet.payInvoice({
      walletId: match.wallet_id,
      paymentRequest: target.bolt11,
      maxSat: due.amount,
      description: 'LN Pool payout ' + match.id,
      extra: {lnpool_match: match.id, lnpool_kind: 'payout'}
    }))
    storage.set(PAYOUTS, {...attempt, status: outcome.status, detail: outcome.detail})
    const settled = recordSettlement(storage.get(MATCHES, match.id) || fresh, payoutAttempts(match.id))
    poke(settled)
    return {match: matchView(settled, players, seats, me)}
  })
}

// ── Payment event ───────────────────────────────────────────────────────────

export function recordLnpoolPayment(eventJson) {
  return runJson(() => {
    const event = parseJsonObject(eventJson)
    const extra = event.extra?.extra_lnpool || event.payment?.extra?.extra_lnpool || {}
    // The settlement lock is an invoice too; paying it is not a buy-in.
    if (extra.kind !== 'buyin') return {recorded: false, reason: 'not-a-buy-in'}
    const paymentHash = cleanText(event.paymentHash || event.payment_hash || event.payment?.payment_hash, 64)
    if (!HEX64.test(paymentHash)) throw new Error('paymentHash is required.')
    const stored = storage.get(MATCHES, cleanText(extra.match_id, 64))
    if (!stored) return {recorded: false, reason: 'unknown-match'}

    const {match, players, seats} = loadMatch(stored.id)
    const existing = players.find(player => player.id === paymentHash)
    if (existing && existing.status !== 'pending') {
      return {recorded: false, reason: 'already-recorded', seat: seatOf(seats, existing)}
    }
    const paidSats = Math.trunc(Math.abs(Number(event.amount ?? event.payment?.amount ?? 0)) / 1000)
    let seat = 0
    if (match.status === 'open' && paidSats === match.stake) seat = !seats[1] ? 1 : !seats[2] ? 2 : 0
    const now = timeNow()
    const player = storage.set(PLAYERS, {
      id: paymentHash,
      match_id: match.id,
      seat,
      name: existing ? existing.name : cleanName(extra.name),
      token_hash: existing ? existing.token_hash : cleanText(extra.token_hash, 64),
      paid_amount: paidSats,
      status: seat ? 'seated' : 'unseated',
      result_seq: -1,
      result_json: '',
      created_at: existing ? existing.created_at : now
    })
    // loadMatch notices the new seat and, once both are taken, starts the
    // match. An unseated buy-in never touches the match row.
    const after = seat ? loadMatch(match.id).match : match
    poke(after)
    return {recorded: true, seat, status: player.status, matchStatus: after.status}
  })
}

// ── Settlement ──────────────────────────────────────────────────────────────

function prizeAmount(match) {
  return Math.floor(match.stake * 2 * (100 - match.fee_percent) / 100)
}

// Who the match owes money to, read from the match row alone.
function entitlement(match) {
  if (match.status === 'finished' && (match.winner === 1 || match.winner === 2)) {
    return {seat: match.winner, amount: prizeAmount(match), reason: 'prize'}
  }
  if (match.status === 'cancelled' && match.seated > 0) {
    return {seat: 1, amount: match.stake, reason: 'refund'}
  }
  return null
}

// At most one invocation ever gets `true` for a given lock invoice.
//
// Extension storage cannot express "insert if absent", so it cannot say which
// of two simultaneous claims came first. The payments table can: LNbits pays a
// given invoice at most once per wallet (the duplicate check runs under the
// wallet's payment lock). Each payout attempt therefore has a 1 sat invoice on
// the hall's own wallet, and paying it is the right to make that attempt. The
// first one is created with the match; each attempt creates the next. When the
// framework grows an atomic storage write or an idempotency key for payments,
// this function is the only thing that needs to change.
function takeSettlementLock(match, lockBolt11) {
  if (!lockBolt11) throw new Error('This match has no settlement lock. The hall operator has to settle it.')
  const lock = wallet.payInvoice({
    walletId: match.wallet_id,
    paymentRequest: lockBolt11,
    maxSat: LOCK_SATS,
    description: 'LN Pool settlement lock ' + match.id,
    extra: {lnpool_match: match.id, lnpool_kind: 'lock'}
  })
  if (lock.ok === true) return true
  const error = String(lock.error || '')
  if (/already paid|still pending/i.test(error)) return false
  // Expired lock, missing payout permission, empty wallet: nobody holds the
  // lock, and nothing has been paid.
  throw new Error('Automatic payout is not available (' + (error || 'the settlement lock could not be taken') + '). Ask the hall operator to settle this match.')
}

function settlementLockInvoice(matchId) {
  return wallet.createInvoicePublic({
    sourceId: matchId,
    amount: LOCK_SATS,
    memo: 'LN Pool settlement lock ' + matchId,
    extra: {kind: 'lock', match_id: matchId}
  }).paymentRequest
}

function payoutAttempts(matchId) {
  return storage.find(PAYOUTS, {filters: {match_id: matchId}, sortBy: 'n', limit: MAX_PAYOUT_ATTEMPTS + 1}).rows
}

// Errors LNbits raises before it creates a payment or talks to the node:
// the call that got one of these sent nothing. Taken from core's
// services/payments.py and wasm_ext/api/background_payments.py. Anything not
// listed here is treated as "a payment may exist".
const NOTHING_SENT = [
  /^Insufficient balance\./,
  /^You must reserve at least /,
  /^Invoice amount \d+ sats is too high/,
  /^The time limit of \d+ seconds between payments has been reached/,
  /^Daily withdrawal limit /,
  /^(missing background payment grant|missing wallet background grant|background grant disabled|payment exceeds max amount|external destination not allowed)$/
]

// What one call to pay a payout invoice proved. (A `bound` attempt made no
// such call; a `started` one has not said what its call proved.)
//   paid     the invoice is paid
//   pending  LNbits has a payment of it in flight
//   refused  this call sent nothing (it says nothing about other calls)
//   failed   the node reported that this payment failed
//   dead     LNbits holds a failed payment of this invoice and will never
//            send it again
//   unknown  anything else
function payoutOutcome(response) {
  const detail = String(response.error || '').slice(0, 300)
  let status = 'unknown'
  if (response.ok === true) status = response.success === true ? 'paid' : response.pending === true ? 'pending' : 'unknown'
  else if (/already paid/i.test(detail)) status = 'paid'
  else if (/still pending/i.test(detail)) status = 'pending'
  else if (/^Payment is failed node/.test(detail)) status = 'dead'
  else if (NOTHING_SENT.some(pattern => pattern.test(detail))) status = 'refused'
  else if (/^Payment failed: /.test(detail)) status = 'failed'
  return {status, detail}
}

// What the recorded attempts prove about a match's payout.
//   unclaimed  nothing was ever tried
//   paid       an attempt paid
//   held       a payment of the bound invoice exists, or may still be made
//              by an attempt that has not reported: only that invoice can be
//              paid
//   released   no payment of any invoice this match was bound to exists or
//              can still be made: a new invoice may be bound
// An invoice is clear only if every attempt on it sent nothing (`bound`,
// `refused`), or LNbits has sealed it (`dead`). One attempt that started and
// never reported, for instance because LNbits stopped the call during the
// payment, keeps it held for good: that is the price of never paying two
// invoices.
function settlementOf(attempts) {
  const last = attempts[attempts.length - 1] || null
  const paid = attempts.find(attempt => attempt.status === 'paid')
  if (paid) return {state: 'paid', last: paid}
  const open = new Map()
  for (const attempt of attempts) {
    if (attempt.status === 'refused' || attempt.status === 'bound') {
      if (!open.has(attempt.bolt11)) open.set(attempt.bolt11, false)
    } else {
      open.set(attempt.bolt11, attempt.status !== 'dead')
    }
  }
  if (!last) return {state: 'unclaimed', last}
  if (![...open.values()].some(Boolean)) return {state: 'released', last}
  // An attempt that sent nothing adds nothing to what is known about the
  // bound invoice.
  return {state: 'held', last, known: [...attempts].reverse().find(attempt => attempt.status !== 'refused' && attempt.status !== 'bound')}
}

// The match row carries a copy of the settlement for the pages and lists. It
// is for display only; claims are decided on the attempt rows.
//   paying       an invoice is bound and about to be paid, or being paid
//   pending      LNbits has the payment in flight
//   paid
//   refused      nothing was sent; the claim can be made again, to any wallet
//   failed       the node reported failure; the next claim asks LNbits to
//                confirm that before another wallet is accepted
//   unconfirmed  a payment may have been made and nothing since has been
//                able to tell
// A refused check adds nothing to what is known about a bound invoice, so it
// never turns `pending` or `unconfirmed` into something else.
function recordSettlement(match, attempts) {
  const {last} = settlementOf(attempts)
  return storage.set(MATCHES, {
    ...match,
    payout_seat: last ? last.seat : 0,
    payout_amount: last ? last.amount : 0,
    payout_hash: last ? last.payment_hash : '',
    payout_status: settlementShown(attempts).status,
    updated_at: timeNow()
  })
}

// The settlement as the pages show it, with LNbits' own words for why.
function settlementShown(attempts) {
  const {state, last, known} = settlementOf(attempts)
  if (state === 'unclaimed') return {status: '', detail: ''}
  if (state === 'paid') return {status: 'paid', detail: ''}
  if (state === 'released') return last.status === 'bound' ? {status: 'paying', detail: ''} : {status: 'refused', detail: last.detail}
  if (known.status === 'started' && known === last) return {status: 'paying', detail: ''}
  const check = last.status === 'refused' ? ' Last check: ' + last.detail : ''
  if (known.status === 'pending') return {status: 'pending', detail: check.trim()}
  if (known.status === 'failed') return {status: 'failed', detail: known.detail + check}
  return {status: 'unconfirmed', detail: (known.detail || 'The payment was started and its result was never recorded.') + check}
}

// Why a payout is not through, for the few states where there is a reason to
// give. Read from the attempt rows, so the match note is left alone.
function settlementDetail(match) {
  if (!['refused', 'failed', 'unconfirmed'].includes(match.payout_status)) return ''
  if (match.payout_bolt11) return match.note.replace(/^Payout failed: /, '')
  return settlementShown(payoutAttempts(match.id)).detail
}

// Turn what the player typed into the one invoice this match will pay.
function payoutInvoice(match, due, destination) {
  const text = cleanText(destination, 2048).replace(/^lightning:/i, '')
  if (!text) throw new Error('Enter a Lightning address, or an invoice for exactly ' + due.amount + ' sats.')
  let bolt11 = text.toLowerCase()
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) || /^lnurl1/i.test(text)) {
    const fetched = wallet.fetchLnurlInvoice({
      walletId: match.wallet_id,
      lnurl: text,
      amount: due.amount,
      description: 'LN Pool payout ' + match.id
    })
    if (fetched.ok !== true || !fetched.paymentRequest) {
      throw new Error('Could not get an invoice from that address: ' + (fetched.error || 'nothing was returned') + '.')
    }
    bolt11 = String(fetched.paymentRequest).toLowerCase()
  }
  if (lightning.validateInvoice(bolt11).valid !== true) throw new Error('That is not a Lightning address or a valid invoice.')
  const decoded = lightning.decodeInvoice(bolt11)
  if (decoded.amountMsat !== due.amount * 1000) throw new Error('The invoice must be for exactly ' + due.amount + ' sats.')
  if (decoded.expiresAt && decoded.expiresAt < timeNow() + 60) throw new Error('That invoice has expired or is about to.')
  if (!HEX64.test(decoded.paymentHash)) throw new Error('That invoice has no payment hash.')
  return {bolt11, paymentHash: decoded.paymentHash}
}

// A match bound by an earlier version keeps its invoice in the match row and
// has no attempt rows. That invoice is all it will ever pay: retrying it is
// safe, replacing it is not, because nothing recorded who else may be paying.
function payLegacyInvoice(match) {
  const outcome = payoutOutcome(wallet.payInvoice({
    walletId: match.wallet_id,
    paymentRequest: match.payout_bolt11,
    maxSat: match.payout_amount,
    description: 'LN Pool payout ' + match.id,
    extra: {lnpool_match: match.id, lnpool_kind: 'payout'}
  }))
  const fresh = storage.get(MATCHES, match.id) || match
  // LNbits checks the balance before it checks for an earlier payment, so a
  // retry can be refused although the invoice was paid. Paid stays paid.
  if (fresh.payout_status === 'paid' || outcome.status === 'paid') {
    return storage.set(MATCHES, {...fresh, payout_status: 'paid', note: /^Payout failed: /.test(fresh.note) ? '' : fresh.note, updated_at: timeNow()})
  }
  const pending = outcome.status === 'pending'
  return storage.set(MATCHES, {
    ...fresh,
    payout_status: pending ? 'pending' : 'failed',
    note: pending ? fresh.note : ('Payout failed: ' + outcome.detail).slice(0, 300),
    updated_at: timeNow()
  })
}

// ── Matches, seats, players ─────────────────────────────────────────────────

function loadMatch(matchId) {
  const id = cleanText(matchId, 64)
  const match = id ? storage.get(MATCHES, id) : null
  if (!match) throw new Error('Match not found.')
  const players = storage.find(PLAYERS, {filters: {match_id: match.id}, sortBy: 'created_at', limit: 50}).rows
  const seats = seatMap(players)
  return {match: refreshSeats(match, seats), players, seats}
}

// Seats are a fact about player rows, which only the payment event writes.
// If two buy-ins ever claim the same seat (their events ran at the same
// instant), the lower payment hash holds it and the other is unseated.
function seatMap(players) {
  const seats = {}
  for (const player of players) {
    if (player.status !== 'seated' || (player.seat !== 1 && player.seat !== 2)) continue
    if (!seats[player.seat] || player.id < seats[player.seat].id) seats[player.seat] = player
  }
  return seats
}

function seatOf(seats, player) {
  if (seats[1] && seats[1].id === player.id) return 1
  if (seats[2] && seats[2].id === player.id) return 2
  return 0
}

// The match row keeps a copy of who is seated, for the lobby and the admin
// list, and flips to `active` when both seats are taken. Only an open match
// is ever touched here, so this can never overwrite a game or a settlement.
function refreshSeats(match, seats) {
  if (match.status !== 'open') return match
  const seated = (seats[1] ? 1 : 0) + (seats[2] ? 1 : 0)
  const p1 = seats[1] ? seats[1].name : ''
  const p2 = seats[2] ? seats[2].name : ''
  if (seated < 2 && seated === match.seated && p1 === match.p1_name && p2 === match.p2_name) return match
  return storage.set(MATCHES, {
    ...match,
    seated,
    p1_name: p1,
    p2_name: p2,
    status: seated === 2 ? 'active' : 'open',
    updated_at: timeNow()
  })
}

// Create the buy-in invoice and the pending player row for one join attempt.
// The seat key is returned to the caller once and only its hash is kept, in
// the row and in the invoice metadata.
function issueBuyIn(match, rawName) {
  const name = cleanName(rawName)
  const key = lightning.randomSecretAndHash()
  const invoice = wallet.createInvoicePublic({
    sourceId: match.id,
    amount: match.stake,
    memo: 'LN Pool buy-in, ' + match.stake + ' sats',
    extra: {kind: 'buyin', match_id: match.id, name, token_hash: key.hash}
  })
  storage.set(PLAYERS, {
    id: invoice.paymentHash,
    match_id: match.id,
    seat: 0,
    name,
    token_hash: key.hash,
    paid_amount: 0,
    status: 'pending',
    result_seq: -1,
    result_json: '',
    created_at: timeNow()
  })
  return {playerId: invoice.paymentHash, token: key.secret, paymentRequest: invoice.paymentRequest, amount: match.stake}
}

function authPlayer(match, players, seats, request, required = true) {
  const playerId = cleanText(request.playerId, 64)
  const token = cleanText(request.token, 64)
  if (!playerId && !token && !required) return null
  if (!HEX64.test(playerId) || !HEX64.test(token)) throw new Error('A valid seat key is required.')
  const row = players.find(player => player.id === playerId)
  if (!row || !lightning.verifyPreimage(token, row.token_hash)) throw new Error('A valid seat key is required.')
  return {row, seat: seatOf(seats, row)}
}

function ownerHall() {
  const now = timeNow()
  return storage.find(HALLS, {sortBy: 'created_at', limit: 1}).rows[0] || {
    id: '',
    wallet_id: '',
    wallet_name: '',
    enabled: false,
    fee_percent: 0,
    min_stake: 100,
    max_stake: 10000,
    created_at: now,
    updated_at: now
  }
}

function requireHall(hallId) {
  const id = cleanText(hallId, 64)
  const hall = id ? storage.get(HALLS, id) : null
  if (!hall) throw new Error('Hall not found.')
  return hall
}

function poke(match) {
  // A hint, not data: clients refetch through the API when they see it.
  websocket.publish(match.id, {t: 'sync', seq: match.seq, status: match.status})
}

// ── Views ───────────────────────────────────────────────────────────────────

function hallView(hall) {
  return {
    id: hall.id,
    enabled: hall.enabled === true,
    walletId: hall.wallet_id,
    walletName: hall.wallet_name,
    feePercent: hall.fee_percent,
    minStake: hall.min_stake,
    maxStake: hall.max_stake
  }
}

// What anyone may see. Never includes a seat key, a key hash, the settlement
// lock, or a payment hash.
function matchView(match, players, seats, me) {
  const due = entitlement(match)
  const detail = settlementDetail(match)
  return {
    id: match.id,
    hallId: match.hall_id,
    status: match.status,
    stake: match.stake,
    feePercent: match.fee_percent,
    prize: prizeAmount(match),
    seats: [1, 2].map(seat => ({seat, name: seats[seat] ? seats[seat].name : '', paid: !!seats[seat]})),
    seq: match.seq,
    turn: match.turn,
    game: parseJson(match.game_json),
    shot: parseJson(match.shot_json),
    winner: match.winner,
    note: match.note,
    settlement: {
      seat: due ? due.seat : match.payout_seat,
      amount: due ? due.amount : match.payout_amount,
      reason: due ? due.reason : '',
      status: match.payout_status,
      ...(detail ? {detail} : {})
    },
    you: me ? {seat: me.seat, status: playerStatus(me.row, me.seat), name: me.row.name, resultSeq: me.row.result_seq} : null,
    updatedAt: match.updated_at,
    serverTime: timeNow()
  }
}

function adminMatchView(match) {
  return {
    id: match.id,
    status: match.status,
    stake: match.stake,
    feePercent: match.fee_percent,
    prize: prizeAmount(match),
    seated: match.seated,
    p1Name: match.p1_name,
    p2Name: match.p2_name,
    seq: match.seq,
    turn: match.turn,
    winner: match.winner,
    payoutSeat: match.payout_seat,
    payoutAmount: match.payout_amount,
    payoutStatus: match.payout_status,
    payoutHash: match.payout_hash,
    note: match.note,
    createdAt: match.created_at,
    updatedAt: match.updated_at
  }
}

// A row can say `seated` and still have lost its seat to a simultaneous
// buy-in (see seatMap); callers that know the seat pass it in.
function playerStatus(player, seat) {
  return player.status === 'seated' && seat === 0 ? 'unseated' : player.status
}

function adminPlayerView(player, seat = player.seat) {
  return {
    paymentHash: player.id,
    matchId: player.match_id,
    name: player.name,
    status: playerStatus(player, seat),
    paidAmount: player.paid_amount,
    createdAt: player.created_at
  }
}

// ── Input handling ──────────────────────────────────────────────────────────

function normalizeShot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shot is required.')
  const shot = {dx: finite(value.dx), dy: finite(value.dy), power: finite(value.power), place: null}
  if (value.place !== null && value.place !== undefined) {
    if (!Array.isArray(value.place) || value.place.length !== 2) throw new Error('shot.place must be [x, y].')
    shot.place = [finite(value.place[0]), finite(value.place[1])]
  }
  return shot
}

// The table after a shot is opaque to the backend except for the two fields
// it acts on. It is kept exactly as sent so the two reports can be compared.
function normalizeResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('result is required.')
  const json = JSON.stringify(value)
  if (json.length > MAX_STATE_BYTES) throw new Error('result is too large.')
  if (value.turn !== 1 && value.turn !== 2) throw new Error('result.turn must be 1 or 2.')
  if (value.winner !== 0 && value.winner !== 1 && value.winner !== 2) throw new Error('result.winner must be 0, 1 or 2.')
  return {json, turn: value.turn, winner: value.winner}
}

function finite(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1000000) {
    throw new Error('shot values must be finite numbers.')
  }
  return value
}

function integerIn(value, fallback, min, max) {
  const number = Number(value ?? fallback)
  const integer = Number.isFinite(number) ? Math.trunc(number) : fallback
  return Math.min(max, Math.max(min, integer))
}

function cleanText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength)
}

function cleanName(value) {
  return cleanText(value, 40).replace(/[\u0000-\u001f\u007f<>&"'`\\]/g, '').trim().slice(0, 18) || 'Player'
}

function parseJson(text) {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch (_error) {
    return null
  }
}

function parseJsonObject(value) {
  if (!value) return {}
  const parsed = typeof value === 'string' ? JSON.parse(value) : value
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('request must be a JSON object.')
  return parsed
}

// The host clock, read at most once per invocation: every host call costs
// fuel, and one call needs only one idea of what time it is.
let invocationTime = 0
let invocationStart = 0

function timeNow() {
  if (!invocationTime) invocationTime = system.now()
  return invocationTime
}

// Milliseconds this invocation has been running, by the guest's own clock.
function elapsedMs() {
  return Date.now() - invocationStart
}

function runJson(fn) {
  invocationTime = 0
  invocationStart = Date.now()
  try {
    return JSON.stringify({ok: true, data: fn()})
  } catch (error) {
    return JSON.stringify({ok: false, error: error instanceof Error ? error.message : String(error)})
  }
}
