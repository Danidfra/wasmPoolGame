import {lightning, storage, system, wallet, websocket} from './lnbits-sdk.js'

// LN Pool backend. It owns everything money depends on (seats, buy-ins, turn
// order, the agreed result, settlement) and nothing else: physics and rules
// run in the two browsers, and a turn only counts once both report the same
// table. See docs/DESIGN.md for the trust model.
//
// Storage is last-writer-wins with no compare-and-set, so every row below has
// as few writers as possible and nothing here relies on a read-check-write
// being atomic. The one step that must not happen twice at once, choosing the
// invoice a match pays out to, is guarded by `takeSettlementLock`. Paying that
// invoice needs no guard: LNbits pays an invoice at most once.

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
const MAX_PAYOUT_CALLS = 40
// LNbits stops a call after wasm_runtime_max_execution_ms (5 s by default),
// time spent in host calls included, and does not cancel a host call that is
// under way. With a slow funding source a payment alone takes that long, so
// any call here can be cut off at any point. A call that is already this late
// does not take the settlement lock.
const BIND_BUDGET_MS = 2500
// How long a payment that has started is left alone before anyone asks about
// it, how often LNbits is asked about one it reports in flight, and how long
// the pages are told "in flight" without a fresh answer. Only pacing: nothing
// about safety depends on these.
const SETTLING_SECONDS = 15
const RECHECK_SECONDS = 15
const PENDING_SHOWN_SECONDS = 120
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
      // Every invoice recorded for the payout and every call made to pay it,
      // oldest first. This is what settlement is decided on; the status in
      // the match row is a copy of it.
      payouts: payoutRows(match.id).filter(isPayoutRow).map(attempt => ({
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

    const rows = payoutRows(match.id)
    const payouts = rows.filter(isPayoutRow)
    // Bound by a version that kept the invoice in the match row.
    if (!payouts.length && match.payout_bolt11) return {match: matchView(payLegacyInvoice(match), players, seats, me)}

    const settlement = settlementOf(payouts)
    if (settlement.state === 'paid') return {match: matchView(recordSettlement(match, payouts), players, seats, me)}
    const answer = settlement.state === 'bound'
      ? payBoundInvoice(match, settlement, due)
      : bindInvoice(match, rows, settlement, due, seats, request.destination)
    return {...answer, match: matchView(answer.match, players, seats, me)}
  })
}

// A claim is up to three calls from the page, each short enough to finish
// inside LNbits' time limit and safe to lose:
//   1. resolve a Lightning address to an invoice (records nothing);
//   2. record that invoice as the one this match pays (takes the lock);
//   3. pay the recorded invoice (see payBoundInvoice).
// This is steps 1 and 2. Recording is the only step that must not happen
// twice, so it is the only one behind the settlement lock, and it does
// nothing slow: no web request, no invoice asked of the funding source.
function bindInvoice(match, rows, settlement, due, seats, destination) {
  const text = cleanText(destination, 2048).replace(/^lightning:/i, '')
  if (!text) throw new Error('Enter a Lightning address, or an invoice for exactly ' + due.amount + ' sats.')
  if (isLightningAddress(text)) {
    return {match, resolved: checkedInvoice(resolveAddress(match, due, text), due).bolt11}
  }
  const invoice = checkedInvoice(text.toLowerCase(), due)

  const payouts = rows.filter(isPayoutRow)
  const first = !payouts.length
  // The lock for this binding and the one a later binding would need. A new
  // match carries the first in its own row; the second was left by the paid
  // event that seated the second player.
  const chain = first ? String(match.lock_bolt11).split(' ') : nextLocks(payouts)
  const lock = chain[0] || ''
  let spare = chain[1] || ''
  if (first && !spare && seats[2]) {
    const left = rows.find(row => row.id === match.id + '-lock-' + seats[2].id)
    if (left) spare = left.next_lock
  }
  if (elapsedMs() > BIND_BUDGET_MS) throw new Error('LNbits is busy. Nothing was sent: claim again in a moment.')
  if (!takeSettlementLock(match, lock)) {
    // Another claim is recording its invoice.
    return {match: storage.get(MATCHES, match.id) || match, settling: true}
  }

  // From here on this is the only invocation that will ever record this
  // binding. Look again: nothing may have changed, except that an older
  // invoice turned out paid.
  const fresh = storage.get(MATCHES, match.id)
  const current = payoutRows(match.id).filter(isPayoutRow)
  const now = settlementOf(current)
  if (now.state === 'paid') return {match: recordSettlement(fresh || match, current)}
  const stillDue = fresh ? entitlement(fresh) : null
  const sameBinding = (now.binding ? now.binding.id : '') === (settlement.binding ? settlement.binding.id : '')
  if (!stillDue || stillDue.seat !== due.seat || stillDue.amount !== due.amount || fresh.payout_status === 'manual' || now.state !== settlement.state || !sameBinding) {
    storage.set(MATCHES, {
      ...(fresh || match),
      payout_status: 'manual',
      note: 'The match changed while it was being settled. Settle it by hand.',
      updated_at: timeNow()
    })
    throw new Error('The match changed while it was being settled. The hall operator has to settle it.')
  }
  const n = current.reduce((highest, row) => Math.max(highest, row.n), 0) + 1
  const createdAt = timeNow()
  let bound = storage.set(PAYOUTS, {
    id: match.id + '-' + n,
    match_id: match.id,
    n,
    seat: due.seat,
    amount: due.amount,
    bolt11: invoice.bolt11,
    payment_hash: invoice.paymentHash,
    status: 'bound',
    detail: '',
    next_lock: spare,
    created_at: createdAt,
    updated_at: createdAt
  })
  const waiting = recordSettlement(fresh, [...current, bound])
  poke(waiting)
  if (!spare && elapsedMs() < BIND_BUDGET_MS) {
    // No lock was left for a later binding. Make one now that this binding is
    // safely recorded; if this call is cut off here, nothing is lost but that.
    try {
      bound = storage.set(PAYOUTS, {...bound, next_lock: settlementLockInvoice(match.id)})
    } catch (_error) {
      // A payment LNbits later declares dead will then need the operator.
    }
  }
  // `bound` tells the page to claim again straight away: that call pays.
  return {match: waiting, settling: true, bound: true}
}

// Step 3 of a claim, and every later look at a payment that did not report:
// one call to LNbits to pay the recorded invoice.
//
// It takes no lock and can be made by any number of invocations at once,
// because they can only ever pay this one invoice and LNbits pays an invoice
// at most once: a second call is answered "already paid" or "still pending"
// from the payment LNbits holds, and sends nothing. The same call is therefore
// the way to find out how a payment ended when the invocation that made it was
// cut off before it could say.
//
// Each call records itself first (`started`) and its answer afterwards, in a
// row of its own. A call cut off in between leaves `started`: a payment may
// exist. The invoice stays the only one this match pays until it is paid or
// LNbits holds a failed payment of it that it will not send again (`dead`).
function payBoundInvoice(match, settlement, due) {
  const {binding, calls} = settlement
  if (binding.seat !== due.seat || binding.amount !== due.amount) {
    throw new Error('The match changed after its payout was recorded. The hall operator has to settle it.')
  }
  const now = timeNow()
  // Somebody is paying right now, or LNbits was asked a moment ago.
  if (calls.some(call => call.status === 'started' && now - call.created_at < SETTLING_SECONDS)) return {match, settling: true}
  const last = calls[calls.length - 1]
  if (last && last.status === 'pending' && now - last.created_at < RECHECK_SECONDS) return {match}
  if (calls.length >= MAX_PAYOUT_CALLS) {
    throw new Error('This payout has been tried too many times. The hall operator has to settle it.')
  }

  const call = storage.set(PAYOUTS, {
    id: match.id + '-' + binding.n + '-' + system.id('pay'),
    match_id: match.id,
    n: binding.n,
    seat: binding.seat,
    amount: binding.amount,
    bolt11: binding.bolt11,
    payment_hash: binding.payment_hash,
    status: 'started',
    detail: '',
    next_lock: '',
    created_at: now,
    updated_at: now
  })
  // If LNbits stops this invocation while the call runs, the payment still
  // completes or fails on its own and nothing below happens.
  const outcome = payoutOutcome(wallet.payInvoice({
    walletId: match.wallet_id,
    paymentRequest: binding.bolt11,
    maxSat: binding.amount,
    description: 'LN Pool payout ' + match.id,
    extra: {lnpool_match: match.id, lnpool_kind: 'payout'}
  }))
  storage.set(PAYOUTS, {...call, status: outcome.status, detail: outcome.detail})
  const settled = recordSettlement(storage.get(MATCHES, match.id) || match, payoutRows(match.id).filter(isPayoutRow))
  poke(settled)
  return {match: settled}
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
    // The match has started and nothing waits on this call, so this is the
    // moment to make the lock a second payout destination would need, should
    // LNbits ever declare the first one dead. Asking the funding source for an
    // invoice is too slow to do while a player waits for a prize.
    if (seat === 2) leaveSpareLock(match.id, paymentHash)
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
// wallet's payment lock). Recording a payout invoice therefore needs a 1 sat
// invoice on the hall's own wallet, and paying it is the right to record. The
// first one is created with the match. When the framework grows an atomic
// storage write or an idempotency key for payments, this function is the only
// thing that needs to change.
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

function payoutRows(matchId) {
  const rows = storage.find(PAYOUTS, {filters: {match_id: matchId}, sortBy: 'n', limit: MAX_PAYOUT_CALLS + 40}).rows
  return rows.sort((a, b) => a.n - b.n || a.created_at - b.created_at || (a.id < b.id ? -1 : 1))
}

// A spare lock left by the paid event is kept in the same table.
function isPayoutRow(row) {
  return row.status !== 'lock'
}

function leaveSpareLock(matchId, paymentHash) {
  try {
    const now = timeNow()
    storage.set(PAYOUTS, {
      id: matchId + '-lock-' + paymentHash,
      match_id: matchId,
      n: 0,
      seat: 0,
      amount: 0,
      bolt11: '',
      payment_hash: '',
      status: 'lock',
      detail: '',
      next_lock: settlementLockInvoice(matchId),
      created_at: now,
      updated_at: now
    })
  } catch (_error) {
    // The match is no worse off: a second destination will need the operator.
  }
}

// The lock a new binding has to take, and after it any spare: kept in the
// last row that names one.
function nextLocks(payouts) {
  const holder = [...payouts].reverse().find(row => row.next_lock)
  return holder ? holder.next_lock.split(' ') : []
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

// What one call to pay a payout invoice proved. (A `bound` row made no such
// call; a `started` one has not said what its call proved.)
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

// What the recorded rows say about a match's payout.
//   unclaimed  no invoice was ever recorded
//   paid       LNbits reported the invoice paid
//   bound      an invoice is recorded and not known to be paid. It is the
//              only thing this match pays, whatever a claim names.
//   released   LNbits holds a failed payment of the recorded invoice and
//              will not send it again: another invoice may be recorded
// Nothing else releases an invoice. In particular a call that LNbits refused
// before sending says nothing about any other call, and a call that never
// reported, for instance because LNbits stopped it during the payment, may
// have paid.
function settlementOf(payouts) {
  const bindings = payouts.filter(row => row.status === 'bound')
  // Rows written before bindings were recorded start with a payment attempt.
  const binding = bindings.length ? bindings[bindings.length - 1] : payouts[0] || null
  if (!binding) return {state: 'unclaimed', binding: null, calls: []}
  // In the order they were made, whichever version wrote them.
  const calls = payouts
    .filter(row => row.status !== 'bound' && row.bolt11 === binding.bolt11)
    .sort((a, b) => a.created_at - b.created_at || a.n - b.n || (a.id < b.id ? -1 : 1))
  if (payouts.some(row => row.status === 'paid')) return {state: 'paid', binding, calls}
  if (calls.some(row => row.status === 'dead')) return {state: 'released', binding, calls}
  return {state: 'bound', binding, calls}
}

// The match row carries a copy of the settlement for the pages and lists. It
// is for display only; claims are decided on the payout rows.
function recordSettlement(match, payouts) {
  const {binding} = settlementOf(payouts)
  return storage.set(MATCHES, {
    ...match,
    payout_seat: binding ? binding.seat : 0,
    payout_amount: binding ? binding.amount : 0,
    payout_hash: binding ? binding.payment_hash : '',
    payout_status: settlementShown(payouts).status,
    updated_at: timeNow()
  })
}

// The settlement as the pages show it, with LNbits' own words for why.
//   paying       an invoice is recorded and being paid
//   pending      LNbits has the payment in flight
//   paid
//   unsent       every call so far was refused before sending; the next
//                claim tries the same invoice again
//   failed       the node reported failure; the next claim asks LNbits to
//                confirm that
//   unconfirmed  a payment may have been made and nothing since has been
//                able to tell
//   released     the payment failed for good; another invoice may be given
// A refused call adds nothing to what is known about an invoice, so it never
// turns `pending`, `failed` or `unconfirmed` into `unsent`.
function settlementShown(payouts) {
  const {state, calls} = settlementOf(payouts)
  if (state === 'unclaimed') return {status: '', detail: ''}
  if (state === 'paid') return {status: 'paid', detail: ''}
  if (state === 'released') return {status: 'released', detail: calls.find(call => call.status === 'dead').detail}
  if (!calls.length) return {status: 'paying', detail: ''}
  const last = calls[calls.length - 1]
  const known = [...calls].reverse().find(call => call.status !== 'refused')
  if (!known) return {status: 'unsent', detail: last.detail}
  if (known.status === 'started' && known === last) return {status: 'paying', detail: ''}
  const check = last.status === 'refused' ? ' Last check: ' + last.detail : ''
  if (known.status === 'pending') return {status: 'pending', detail: check.trim()}
  if (known.status === 'failed') return {status: 'failed', detail: known.detail + check}
  return {status: 'unconfirmed', detail: (known.detail || NEVER_RECORDED) + check}
}

const NEVER_RECORDED = 'The payment was started and its result was never recorded.'

// What the pages are told. The copy in the match row cannot age by itself: a
// payment whose invocation was cut off stays `paying` there for ever. Shown
// to a player, that must not read as "sending" for longer than a payment can
// take.
function shownStatus(match) {
  // `refused` is what earlier versions called a payment that was not sent.
  const status = match.payout_status === 'refused' ? 'unsent' : match.payout_status
  const age = timeNow() - match.updated_at
  if (status === 'paying' && age > SETTLING_SECONDS) return 'unconfirmed'
  if (status === 'pending' && age > PENDING_SHOWN_SECONDS) return 'unconfirmed'
  return status
}

// Why a payout is not through, for the states where there is a reason to
// give. Read from the payout rows, so the match note is left alone.
function settlementDetail(match, status) {
  if (!['unsent', 'failed', 'unconfirmed', 'released'].includes(status)) return ''
  if (match.payout_bolt11) return match.note.replace(/^Payout failed: /, '')
  const payouts = payoutRows(match.id).filter(isPayoutRow)
  if (!settlementOf(payouts).calls.length) return 'The invoice was recorded and no payment has been made yet.'
  return settlementShown(payouts).detail || NEVER_RECORDED
}

function isLightningAddress(text) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) || /^lnurl1/i.test(text)
}

// Ask a Lightning address for an invoice of the amount owed.
function resolveAddress(match, due, address) {
  const fetched = wallet.fetchLnurlInvoice({
    walletId: match.wallet_id,
    lnurl: address,
    amount: due.amount,
    description: 'LN Pool payout ' + match.id
  })
  if (fetched.ok !== true || !fetched.paymentRequest) {
    throw new Error('Could not get an invoice from that address: ' + (fetched.error || 'nothing was returned') + '.')
  }
  return String(fetched.paymentRequest).toLowerCase()
}

// An invoice this match may be bound to: valid, for exactly the amount owed,
// and not about to expire.
function checkedInvoice(bolt11, due) {
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
  const status = shownStatus(match)
  const detail = settlementDetail(match, status)
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
      status,
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
    payoutStatus: shownStatus(match),
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
