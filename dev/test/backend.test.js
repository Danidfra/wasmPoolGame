import assert from 'node:assert/strict'
import {test} from 'node:test'
import {FLOAT, createHost, openHall, playTurn, startMatch} from './helpers.mjs'

const table = (turn, winner = 0) => ({balls: [[750, 250]], turn, groups: 0, inHand: false, breaking: false, winner, shots: 1, last: null})
const outgoing = (host, kind) => host.payments.filter(payment => payment.kind === kind)
// The invoices recorded for a match's payout and the calls made to pay them, in order.
const payoutsOf = (host, match) => host.rows('lnpool_payouts')
  .filter(row => row.match_id === match.matchId && row.status !== 'lock')
  .sort((a, b) => a.n - b.n || a.created_at - b.created_at || (a.id < b.id ? -1 : 1))
const hostCallsOf = (host, run) => {
  host.hostCalls.length = 0
  run()
  return [...host.hostCalls]
}
const claim = (host, match, seat, destination) => host.claim({...match[seat], destination}).match

// ── Hall ────────────────────────────────────────────────────────────────────

test('a hall cannot be opened on a wallet the owner does not have', () => {
  const host = createHost()
  const result = host.call('saveLnpoolHall', {enabled: true, walletId: 'wallet_of_someone_else'})
  assert.equal(result.ok, false)
  assert.match(result.error, /not one of yours/)
  assert.equal(host.call('saveLnpoolHall', {enabled: true, walletId: ''}).ok, false)
})

test('saving twice keeps one hall and clamps its settings', () => {
  const host = createHost()
  const first = openHall(host, {minStake: 500, maxStake: 100, feePercent: 80})
  const second = openHall(host, {feePercent: 5})
  assert.equal(second.id, first.id)
  assert.equal(host.rows('lnpool_halls').length, 1)
  assert.equal(first.maxStake, 500, 'the largest stake is never below the smallest')
  assert.equal(first.feePercent, 50)
  assert.equal(second.feePercent, 5)
})

// ── Creating and joining ────────────────────────────────────────────────────

test('a match needs an open hall and a stake inside its limits', () => {
  const host = createHost()
  const hall = openHall(host, {enabled: false})
  assert.match(host.call('createLnpoolMatch', {hallId: hall.id, stake: 1000}).error, /closed/)
  openHall(host)
  for (const stake of [99, 10001, 150.5, 'abc']) {
    assert.equal(host.call('createLnpoolMatch', {hallId: hall.id, stake}).ok, false, 'stake ' + stake)
  }
  assert.match(host.call('createLnpoolMatch', {hallId: 'hall_nope', stake: 1000}).error, /Hall not found/)
})

test('creating a match issues a buy-in invoice and a settlement lock, and leaks neither secret', () => {
  const host = createHost()
  const hall = openHall(host)
  const created = host.ok('createLnpoolMatch', {hallId: hall.id, name: 'Ana', stake: 1000})
  const stored = host.row('lnpool_matches', created.match.id)

  assert.equal(host.invoice(created.paymentRequest).amount, 1000)
  assert.equal(host.invoice(stored.lock_bolt11).amount, 1)
  assert.equal(created.match.status, 'open')
  assert.match(created.token, /^[0-9a-f]{64}$/)

  // The seat key is returned once and is stored nowhere, only its hash.
  const everything = JSON.stringify([host.rows('lnpool_matches'), host.rows('lnpool_players'), host.invoice(created.paymentRequest).extra])
  assert.ok(!everything.includes(created.token))
  const player = host.row('lnpool_players', created.playerId)
  const views = JSON.stringify([
    host.ok('getPublicLnpoolMatch', {matchId: created.match.id}),
    host.ok('syncLnpoolMatch', {matchId: created.match.id, playerId: created.playerId, token: created.token}),
    host.ok('getPublicLnpoolHall', {hallId: hall.id})
  ])
  for (const secret of [created.token, player.token_hash, stored.lock_bolt11, created.playerId]) {
    assert.ok(!views.includes(secret), 'a public view leaked ' + secret.slice(0, 12))
  }
})

test('the match starts only when both buy-ins have been paid', () => {
  const host = createHost()
  const hall = openHall(host)
  const created = host.ok('createLnpoolMatch', {hallId: hall.id, name: 'Ana', stake: 1000})
  const matchId = created.match.id
  assert.deepEqual(host.ok('getPublicLnpoolHall', {hallId: hall.id}).matches, [], 'an unpaid match is not in the lobby')

  assert.equal(host.payBuyIn(created.paymentRequest).data.seat, 1)
  const lobby = host.ok('getPublicLnpoolHall', {hallId: hall.id}).matches
  assert.deepEqual(lobby.map(match => [match.id, match.host, match.stake, match.prize]), [[matchId, 'Ana', 1000, 2000]])

  const joined = host.ok('joinLnpoolMatch', {matchId, name: 'Bo'})
  assert.equal(host.ok('getPublicLnpoolMatch', {matchId}).match.status, 'open', 'an unpaid joiner does not start the match')
  assert.equal(host.payBuyIn(joined.paymentRequest).data.seat, 2)

  const view = host.ok('syncLnpoolMatch', {matchId, playerId: joined.playerId, token: joined.token}).match
  assert.equal(view.status, 'active')
  assert.deepEqual(view.seats, [{seat: 1, name: 'Ana', paid: true}, {seat: 2, name: 'Bo', paid: true}])
  assert.equal(view.you.seat, 2)
  assert.equal(view.turn, 1)
  assert.deepEqual(host.ok('getPublicLnpoolHall', {hallId: hall.id}).matches, [], 'a started match leaves the lobby')
  assert.match(host.call('joinLnpoolMatch', {matchId, name: 'Cy'}).error, /not open/)
})

test('a browser cannot seat itself: only the paid event does', () => {
  const host = createHost()
  const hall = openHall(host)
  const created = host.ok('createLnpoolMatch', {hallId: hall.id, name: 'Ana', stake: 1000})
  const creds = {matchId: created.match.id, playerId: created.playerId, token: created.token}
  const view = host.ok('syncLnpoolMatch', creds).match
  assert.equal(view.you.seat, 0)
  assert.equal(view.you.status, 'pending')
  assert.match(host.call('cancelLnpoolMatch', creds).error, /first player/)
})

test('delivering the paid event twice changes nothing', () => {
  const host = createHost()
  const match = startMatch(host)
  const before = JSON.stringify([host.rows('lnpool_matches'), host.rows('lnpool_players')])
  for (const bolt11 of match.invoices) {
    const again = host.call('recordLnpoolPayment', host.paidEvent(bolt11))
    assert.equal(again.data.reason, 'already-recorded')
  }
  assert.equal(JSON.stringify([host.rows('lnpool_matches'), host.rows('lnpool_players')]), before)
  assert.equal(host.ok('getPublicLnpoolMatch', {matchId: match.matchId}).match.status, 'active')
})

test('paying the settlement lock from outside is not a buy-in', () => {
  const host = createHost()
  const hall = openHall(host)
  const created = host.ok('createLnpoolMatch', {hallId: hall.id, name: 'Ana', stake: 1000})
  const lock = host.row('lnpool_matches', created.match.id).lock_bolt11
  const result = host.call('recordLnpoolPayment', host.paidEvent(lock))
  assert.deepEqual(result.data, {recorded: false, reason: 'not-a-buy-in'})
  assert.equal(host.rows('lnpool_players').filter(player => player.status === 'seated').length, 0)
})

test('only one join invoice is outstanding per free seat', () => {
  const host = createHost()
  const hall = openHall(host)
  const created = host.ok('createLnpoolMatch', {hallId: hall.id, name: 'Ana', stake: 1000})
  const matchId = created.match.id
  host.payBuyIn(created.paymentRequest)

  const first = host.ok('joinLnpoolMatch', {matchId, name: 'Bo'})
  assert.match(host.call('joinLnpoolMatch', {matchId, name: 'Cy'}).error, /paying for this seat/)

  // The hold lapses, a second player gets an invoice, and then both pay.
  host.now += 181
  const second = host.ok('joinLnpoolMatch', {matchId, name: 'Cy'})
  assert.equal(host.payBuyIn(second.paymentRequest).data.seat, 2)
  const late = host.payBuyIn(first.paymentRequest)
  assert.equal(late.data.seat, 0)
  assert.equal(late.data.status, 'unseated')

  // The late buy-in is visible to the player and to the operator, and the
  // match carries on without it.
  const lateView = host.ok('syncLnpoolMatch', {matchId, playerId: first.playerId, token: first.token}).match
  assert.equal(lateView.you.status, 'unseated')
  assert.equal(lateView.status, 'active')
  assert.deepEqual(lateView.seats.map(seat => seat.name), ['Ana', 'Cy'])
  const admin = host.ok('listLnpoolMatches', {})
  assert.deepEqual(admin.unseated.map(player => [player.name, player.paidAmount, player.paymentHash]), [['Bo', 1000, first.playerId]])
})

test('a buy-in of the wrong amount does not get a seat', () => {
  const host = createHost()
  const hall = openHall(host)
  const created = host.ok('createLnpoolMatch', {hallId: hall.id, name: 'Ana', stake: 1000})
  const result = host.payBuyIn(created.paymentRequest, {amountMsat: 999000})
  assert.equal(result.data.seat, 0)
  assert.equal(host.ok('getPublicLnpoolMatch', {matchId: created.match.id}).match.seats[0].paid, false)
})

test('two buy-ins that both claimed a seat are resolved the same way for everyone', () => {
  const host = createHost()
  const match = startMatch(host)
  const holder = host.rows('lnpool_players').find(player => player.seat === 2)
  const seatTwo = () => host.ok('getPublicLnpoolMatch', {matchId: match.matchId}).match.seats[1].name

  // What two payment events running at the same instant could leave behind:
  // a second row that also says "seat 2". The lower payment hash holds the
  // seat, whoever reads and whenever.
  host.rawSet('lnpool_players', {...holder, id: 'f'.repeat(64), name: 'Zed'})
  assert.equal(seatTwo(), 'Bo')
  host.rawSet('lnpool_players', {...holder, id: '0'.repeat(64), name: 'Zed'})
  assert.equal(seatTwo(), 'Zed')

  // The one who lost the seat is told so, and cannot act as a player.
  const lost = host.ok('syncLnpoolMatch', {...match[2]}).match.you
  assert.deepEqual([lost.seat, lost.status], [0, 'unseated'])
  assert.match(host.call('concedeLnpoolMatch', {...match[2]}).error, /seated player/)
})

// ── Seat keys ───────────────────────────────────────────────────────────────

test('every player action needs the seat key of a seated player', () => {
  const host = createHost()
  const match = startMatch(host)
  const wrongToken = {...match[1], token: 'a'.repeat(64)}
  const swapped = {...match[1], token: match[2].token}
  const shot = {dx: -1, dy: 0, power: 50, place: null}
  for (const creds of [wrongToken, swapped, {matchId: match.matchId}, {...match[1], token: 'short'}]) {
    for (const [name, extra] of [
      ['shootLnpoolMatch', {seq: 0, shot}],
      ['reportLnpoolResult', {seq: 0, result: table(2)}],
      ['concedeLnpoolMatch', {}],
      ['claimLnpoolPayout', {destination: 'x@y.z'}],
      ['cancelLnpoolMatch', {}]
    ]) {
      const result = host.call(name, {...creds, ...extra})
      assert.equal(result.ok, false, name)
      assert.match(result.error, /seat key/, name)
    }
  }
  assert.equal(host.row('lnpool_matches', match.matchId).shot_json, '')
})

test('a seat key from one match is useless in another', () => {
  const host = createHost()
  const hall = openHall(host)
  const one = startMatch(host, {hall})
  const two = startMatch(host, {hall})
  const result = host.call('concedeLnpoolMatch', {...one[1], matchId: two.matchId})
  assert.match(result.error, /seat key/)
  assert.equal(host.ok('getPublicLnpoolMatch', {matchId: two.matchId}).match.status, 'active')
})

// ── Turns ───────────────────────────────────────────────────────────────────

test('only the player whose turn it is can shoot, once, at the current shot number', () => {
  const host = createHost()
  const match = startMatch(host)
  const shot = {dx: -0.6, dy: 0.8, power: 72.5, place: null}
  assert.match(host.call('shootLnpoolMatch', {...match[2], seq: 0, shot}).error, /not your turn/)
  assert.match(host.call('shootLnpoolMatch', {...match[1], seq: 1, shot}).error, /moved on/)
  for (const bad of [{dx: 'a', dy: 0, power: 1}, {dx: 1, dy: 0}, {dx: 1, dy: 0, power: Infinity}, {dx: 1, dy: 0, power: 50, place: [1]}, null]) {
    assert.equal(host.call('shootLnpoolMatch', {...match[1], seq: 0, shot: bad}).ok, false)
  }

  const view = host.ok('shootLnpoolMatch', {...match[1], seq: 0, shot}).match
  assert.deepEqual(view.shot, {seq: 0, seat: 1, shot})
  // A resend with a different aim does not replace the recorded shot.
  const again = host.ok('shootLnpoolMatch', {...match[1], seq: 0, shot: {...shot, power: 10}}).match
  assert.deepEqual(again.shot.shot, shot)
})

test('a turn is committed only when both players report the same table', () => {
  const host = createHost()
  const match = startMatch(host)
  assert.match(host.call('reportLnpoolResult', {...match[1], seq: 0, result: table(2)}).error, /no shot/)
  host.ok('shootLnpoolMatch', {...match[1], seq: 0, shot: {dx: -1, dy: 0, power: 50, place: null}})

  // The shooter alone cannot move the match on, however often they report.
  for (let i = 0; i < 3; i += 1) {
    const alone = host.ok('reportLnpoolResult', {...match[1], seq: 0, result: table(1, 1)}).match
    assert.equal(alone.seq, 0)
    assert.equal(alone.status, 'active')
    assert.equal(alone.winner, 0)
  }
  // The shooter may still correct their own report before the other arrives.
  host.ok('reportLnpoolResult', {...match[1], seq: 0, result: table(2)})
  const committed = host.ok('reportLnpoolResult', {...match[2], seq: 0, result: table(2)}).match
  assert.equal(committed.seq, 1)
  assert.equal(committed.turn, 2)
  assert.equal(committed.shot, null)
  assert.deepEqual(committed.game, table(2))

  // Reports for a turn that is already committed are ignored.
  const stale = host.ok('reportLnpoolResult', {...match[1], seq: 0, result: table(1, 1)}).match
  assert.equal(stale.seq, 1)
  assert.equal(stale.status, 'active')
})

test('a result the backend cannot act on is refused', () => {
  const host = createHost()
  const match = startMatch(host)
  host.ok('shootLnpoolMatch', {...match[1], seq: 0, shot: {dx: -1, dy: 0, power: 50, place: null}})
  for (const result of [{...table(2), turn: 3}, {...table(2), winner: 5}, {...table(2), pad: 'x'.repeat(5000)}, [], 'x']) {
    assert.equal(host.call('reportLnpoolResult', {...match[1], seq: 0, result}).ok, false)
  }
})

test('different reports freeze the match and keep the evidence', () => {
  const host = createHost()
  const match = startMatch(host)
  const shot = {dx: -1, dy: 0, power: 50, place: null}
  host.ok('shootLnpoolMatch', {...match[1], seq: 0, shot})
  host.ok('reportLnpoolResult', {...match[1], seq: 0, result: table(1, 1)})
  const view = host.ok('reportLnpoolResult', {...match[2], seq: 0, result: table(2)}).match
  assert.equal(view.status, 'disputed')
  assert.equal(view.winner, 0)

  // Nobody is owed anything, and nothing more can be played or claimed.
  for (const seat of [1, 2]) {
    assert.match(host.call('claimLnpoolPayout', {...match[seat], destination: host.externalInvoice(2000)}).error, /nothing for this seat/)
  }
  assert.match(host.call('shootLnpoolMatch', {...match[1], seq: 0, shot}).error, /not being played/)
  assert.equal(host.payments.length, 0)

  const detail = host.ok('getLnpoolMatchAdmin', {matchId: match.matchId})
  assert.deepEqual(detail.evidence.shot, {seq: 0, seat: 1, shot})
  assert.deepEqual(detail.evidence.reports.map(report => [report.seat, report.seq, report.result.winner]), [[1, 0, 1], [2, 0, 0]])
})

test('simultaneous reports both commit, and commit the same thing', () => {
  const host = createHost()
  const match = startMatch(host)
  host.ok('shootLnpoolMatch', {...match[1], seq: 0, shot: {dx: -1, dy: 0, power: 50, place: null}})
  host.ok('reportLnpoolResult', {...match[1], seq: 0, result: table(2)})
  // Seat 2's report, then seat 1 reporting again before it has seen the commit.
  host.ok('reportLnpoolResult', {...match[2], seq: 0, result: table(2)})
  const first = JSON.stringify(host.row('lnpool_matches', match.matchId))
  host.rawSet('lnpool_matches', {...host.row('lnpool_matches', match.matchId), seq: 0, turn: 1, game_json: '', shot_json: JSON.stringify({seq: 0, seat: 1, shot: {dx: -1, dy: 0, power: 50, place: null}})})
  host.ok('reportLnpoolResult', {...match[1], seq: 0, result: table(2)})
  assert.equal(JSON.stringify(host.row('lnpool_matches', match.matchId)), first)
})

// ── Winning and being paid ──────────────────────────────────────────────────

test('the agreed winner is paid the pot exactly once', () => {
  const host = createHost()
  const match = startMatch(host, {stake: 1000})
  assert.equal(host.balance, FLOAT + 2000)
  const finished = playTurn(host, match, table(1, 1))
  assert.equal(finished.status, 'finished')
  assert.equal(finished.winner, 1)
  assert.deepEqual(finished.settlement, {seat: 1, amount: 2000, reason: 'prize', status: ''})

  assert.match(host.call('claimLnpoolPayout', {...match[2], destination: host.externalInvoice(2000)}).error, /nothing for this seat/)
  assert.match(host.call('claimLnpoolPayout', {...match[1], destination: host.externalInvoice(2001)}).error, /exactly 2000 sats/)
  assert.match(host.call('claimLnpoolPayout', {...match[1], destination: host.externalInvoice(2000, {expiresIn: 10})}).error, /expired/)
  assert.match(host.call('claimLnpoolPayout', {...match[1], destination: 'not an invoice'}).error, /not a Lightning address/)
  assert.match(host.call('claimLnpoolPayout', {...match[1], destination: ''}).error, /Enter a Lightning address/)
  assert.equal(host.payments.length, 0, 'a refused claim pays nothing and does not use up the lock')

  const invoice = host.externalInvoice(2000)
  const paid = host.claim({...match[1], destination: invoice}).match
  assert.equal(paid.settlement.status, 'paid')
  assert.deepEqual(outgoing(host, 'payout').map(payment => [payment.bolt11, payment.amount]), [[invoice, 2000]])
  assert.equal(outgoing(host, 'lock').length, 1, 'the lock is paid once, to record the invoice')
  assert.equal(host.balance, FLOAT)
  assert.deepEqual(payoutsOf(host, match).map(row => [row.bolt11, row.status]), [[invoice, 'bound'], [invoice, 'paid']])

  // Claiming again, with the same or another invoice, pays nothing more.
  host.balance = 5000
  for (const destination of [invoice, host.externalInvoice(2000), '']) {
    const again = host.claim({...match[1], destination}).match
    assert.equal(again.settlement.status, 'paid')
  }
  assert.equal(outgoing(host, 'payout').length, 1)
  assert.equal(host.balance, 5000)
})

test('the hall fee comes out of the pot', () => {
  const host = createHost()
  const hall = openHall(host, {feePercent: 10})
  const match = startMatch(host, {stake: 555, hall})
  const finished = playTurn(host, match, table(2, 2))
  assert.equal(finished.settlement.amount, 999)
  host.claim({...match[2], destination: host.externalInvoice(999)})
  assert.equal(host.balance, FLOAT + 1110 - 999)
})

test('a Lightning address is resolved in a call of its own, to one invoice, which is then the only one paid', () => {
  const host = createHost()
  const match = startMatch(host)
  playTurn(host, match, table(1, 1))
  const issued = []
  host.lnurl.set('ana@wallet.example', amount => {
    issued.push(host.externalInvoice(amount))
    return issued.at(-1)
  })
  assert.match(host.call('claimLnpoolPayout', {...match[1], destination: 'nobody@wallet.example'}).error, /Could not get an invoice/)

  // The first call only asks the address for an invoice and hands it back.
  const resolved = host.ok('claimLnpoolPayout', {...match[1], destination: 'ana@wallet.example'})
  assert.equal(resolved.resolved, issued[0])
  assert.equal(resolved.match.settlement.status, '')
  assert.equal(host.payments.length, 0, 'not even the lock')
  assert.equal(payoutsOf(host, match).length, 0)

  // The page sends the invoice back; that call records it; the next pays it.
  const bound = host.ok('claimLnpoolPayout', {...match[1], destination: resolved.resolved})
  assert.equal(bound.bound, true)
  assert.equal(host.claim({...match[1], destination: 'ana@wallet.example'}).match.settlement.status, 'paid')
  assert.equal(issued.length, 1, 'once an invoice is recorded, the address is not asked again')
  assert.deepEqual(outgoing(host, 'payout').map(payment => payment.bolt11), issued)
})

test('two claims racing to record an invoice record one', () => {
  const host = createHost()
  const match = startMatch(host)
  playTurn(host, match, table(1, 1))
  const first = host.externalInvoice(2000)
  const second = host.externalInvoice(2000)
  host.balance = 100000 // plenty, so only the lock stands between the wallet and a double payout

  // While the first claim is inside its lock payment (before it has written
  // anything), a second claim with another invoice runs start to finish.
  let nested = null
  host.beforePay = bolt11 => {
    if (host.invoice(bolt11).internal && !nested) {
      nested = host.call('claimLnpoolPayout', {...match[1], destination: second})
    }
  }
  const outer = host.ok('claimLnpoolPayout', {...match[1], destination: first})
  host.beforePay = null

  assert.equal(nested.ok, true)
  assert.equal(nested.data.settling, true, 'the loser of the race is told to wait')
  assert.equal(nested.data.bound, undefined)
  assert.equal(outer.bound, true)
  assert.deepEqual(payoutsOf(host, match).map(row => [row.bolt11, row.status]), [[first, 'bound']])

  // Whoever claims next, and whatever they name, the recorded invoice is paid.
  const paid = claim(host, match, 1, second)
  assert.equal(paid.settlement.status, 'paid')
  assert.deepEqual(outgoing(host, 'payout').map(payment => payment.bolt11), [first])
  assert.equal(host.invoice(second).payment, '')
})

test('a match that flips winner after it was paid still pays only once', () => {
  const host = createHost()
  const match = startMatch(host)
  playTurn(host, match, table(1, 1))
  host.balance = 100000
  host.claim({...match[1], destination: host.externalInvoice(2000)})
  // Two colluding players rewrite the result (a stale write landing late).
  host.rawSet('lnpool_matches', {...host.row('lnpool_matches', match.matchId), winner: 2, payout_status: '', payout_bolt11: '', payout_seat: 0})
  const second = host.externalInvoice(2000)
  const result = host.call('claimLnpoolPayout', {...match[2], destination: second})
  assert.equal(result.ok, true)
  assert.equal(result.data.match.settlement.status, 'paid', 'the recorded payment says this match was paid')
  assert.equal(outgoing(host, 'payout').length, 1)
  assert.equal(host.invoice(second).paid, false)
  assert.equal(host.row('lnpool_matches', match.matchId).payout_status, 'paid', 'and the copy in the match row is put right')
})

test('a payout that is still in flight is found again, not repeated', () => {
  const host = createHost()
  const match = startMatch(host)
  playTurn(host, match, table(1, 1))
  const invoice = host.externalInvoice(2000)
  host.invoice(invoice).leavePending = true
  host.balance = 100000 // LNbits answers about a payment only while the wallet could pay it again
  const pending = host.claim({...match[1], destination: invoice}).match
  assert.equal(pending.settlement.status, 'pending')
  // Asking again straight away does not bother LNbits.
  assert.equal(claim(host, match, 1, '').settlement.status, 'pending')
  assert.equal(payoutsOf(host, match).length, 2)
  host.now += 30
  const settled = host.claim({...match[1], destination: ''}).match
  assert.equal(settled.settlement.status, 'paid')
  assert.equal(outgoing(host, 'payout').length, 1)
  assert.deepEqual(payoutsOf(host, match).map(row => [row.bolt11, row.status]), [[invoice, 'bound'], [invoice, 'pending'], [invoice, 'paid']])
})

// ── When a payout does not go through ───────────────────────────────────────
// One invoice is recorded for a match, behind the settlement lock. Paying it,
// and asking about it afterwards, is a plain call to LNbits that anyone may
// repeat: LNbits pays an invoice at most once. The invoice stays the only one
// until it is paid or LNbits itself declares its payment dead.

// The first real-Lightning test: stakes of 5, a 10% fee, and a hall wallet
// holding nothing but the pot. LNbits wants the prize plus 2 sats of
// routing-fee reserve and refuses before sending anything.
function fundedOnlyByThePot() {
  const host = createHost({float: 0})
  const hall = openHall(host, {feePercent: 10, minStake: 1})
  const match = startMatch(host, {stake: 5, hall})
  const finished = playTurn(host, match, table(1, 1))
  assert.equal(finished.settlement.amount, 9)
  assert.equal(host.balance, 10)
  return {host, match}
}

test('a hall wallet holding only the pot cannot pay: nothing is sent, and after a top-up the same claim is paid', () => {
  const {host, match} = fundedOnlyByThePot()
  const first = host.externalInvoice(9)
  const unsent = claim(host, match, 1, first)
  assert.equal(unsent.status, 'finished')
  assert.equal(unsent.settlement.status, 'unsent')
  assert.match(unsent.settlement.detail, /^You must reserve at least \(2 +sat\) to cover potential routing fees/)
  assert.deepEqual([unsent.settlement.seat, unsent.settlement.amount], [1, 9], 'the prize has not changed')
  assert.equal(outgoing(host, 'payout').length, 0)
  assert.equal(host.balance, 10, 'the pot is untouched')
  assert.deepEqual(payoutsOf(host, match).map(row => [row.bolt11, row.status]), [[first, 'bound'], [first, 'refused']])

  // Trying again changes nothing while the wallet is short. Naming another
  // wallet changes nothing either: the recorded invoice is the one.
  const second = host.externalInvoice(9)
  host.now += 10
  assert.equal(claim(host, match, 1, second).settlement.status, 'unsent')
  host.now += 10
  assert.equal(claim(host, match, 1, '').settlement.status, 'unsent')
  assert.equal(outgoing(host, 'payout').length, 0)
  assert.equal(outgoing(host, 'lock').length, 1, 'trying again takes no lock')

  // The operator tops the wallet up. The winner claims again and gets the
  // full prize, on the invoice recorded at the start.
  host.balance += 2
  host.now += 10
  const paid = claim(host, match, 1, second)
  assert.deepEqual(paid.settlement, {seat: 1, amount: 9, reason: 'prize', status: 'paid'})
  assert.deepEqual(outgoing(host, 'payout').map(payment => [payment.bolt11, payment.amount]), [[first, 9]])

  // And that is all this match ever pays.
  host.balance = 1000
  for (const destination of [first, second, host.externalInvoice(9), '']) {
    assert.equal(claim(host, match, 1, destination).settlement.status, 'paid')
  }
  assert.equal(outgoing(host, 'payout').length, 1)
  assert.equal(host.invoice(second).payment, '', 'LNbits was never asked to pay another invoice')
})

test('a payout that is not sent leaves the match note alone', () => {
  const host = createHost({float: 0})
  const match = startMatch(host)
  host.ok('concedeLnpoolMatch', {...match[2]})
  const unsent = claim(host, match, 1, host.externalInvoice(2000))
  assert.equal(unsent.settlement.status, 'unsent')
  assert.equal(unsent.note, 'Bo conceded.')
  // Somebody watching sees the state too.
  assert.equal(host.ok('getPublicLnpoolMatch', {matchId: match.matchId}).match.settlement.status, 'unsent')
})

test('the prize is never reduced to fit the wallet', () => {
  const {host, match} = fundedOnlyByThePot()
  assert.match(host.call('claimLnpoolPayout', {...match[1], destination: host.externalInvoice(8)}).error, /exactly 9 sats/)
  const full = host.externalInvoice(9)
  claim(host, match, 1, full)
  // An invoice for less, offered afterwards, is not taken up.
  const smaller = host.externalInvoice(7)
  host.now += 10
  assert.equal(claim(host, match, 1, smaller).settlement.status, 'unsent')
  host.balance += 2
  host.now += 10
  assert.equal(claim(host, match, 1, smaller).settlement.status, 'paid')
  assert.deepEqual(outgoing(host, 'payout').map(payment => [payment.bolt11, payment.amount]), [[full, 9]])
})

test('a hall fee that covers the routing reserve needs no float', () => {
  const host = createHost({float: 0})
  const hall = openHall(host, {feePercent: 10})
  const match = startMatch(host, {stake: 100, hall})
  playTurn(host, match, table(1, 1))
  assert.equal(claim(host, match, 1, host.externalInvoice(180)).settlement.status, 'paid')
  assert.equal(host.balance, 20)
})

test('once an invoice is recorded, it is the one paid, whatever the next call names', () => {
  const host = createHost()
  const match = startMatch(host)
  playTurn(host, match, table(1, 1))
  const first = host.externalInvoice(2000)
  const other = host.externalInvoice(2000)
  assert.equal(host.ok('claimLnpoolPayout', {...match[1], destination: first}).bound, true)
  assert.equal(host.ok('claimLnpoolPayout', {...match[1], destination: other}).match.settlement.status, 'paid')
  assert.deepEqual(outgoing(host, 'payout').map(payment => payment.bolt11), [first])
})

test('a refused check says nothing about a payment that is still out', () => {
  const host = createHost()
  const match = startMatch(host)
  playTurn(host, match, table(1, 1))
  const first = host.externalInvoice(2000)
  const other = host.externalInvoice(2000)
  host.invoice(first).stayPending = true
  assert.equal(claim(host, match, 1, first).settlement.status, 'pending')

  // The wallet is drained while that payment is out. LNbits checks the
  // balance before it looks for an earlier payment, so the next call is
  // refused although a payment exists.
  host.balance = 50
  host.now += 30
  const held = claim(host, match, 1, other)
  assert.equal(held.settlement.status, 'pending', 'a refused check does not turn a payment in flight into anything else')
  assert.deepEqual(payoutsOf(host, match).map(row => row.status), ['bound', 'pending', 'refused'])

  host.balance = 100000
  host.now += 30
  assert.equal(claim(host, match, 1, other).settlement.status, 'pending')
  host.invoice(first).payment = 'success' // the first payment lands
  host.now += 30
  assert.equal(claim(host, match, 1, other).settlement.status, 'paid')
  assert.equal(host.invoice(other).payment, '', 'LNbits was never asked to pay the second invoice')
})

// LNbits stops a call after 5 s and does not cancel a payment that is under
// way. With a slow funding source the payment arrives and the invocation that
// made it is killed before it can record anything. This happened on both real
// payouts that took longer than the limit.
function cutOffDuringPayment(host, match, destination) {
  assert.equal(host.ok('claimLnpoolPayout', {...match[1], destination}).bound, true)
  host.cutOff = invoice => !invoice.internal
  const lost = host.call('claimLnpoolPayout', {...match[1], destination})
  host.cutOff = null
  assert.deepEqual(lost, {ok: false, error: 'wasm trap: interrupt'})
}

test('a payment that arrives while the call is cut off is found again, never repeated, never redirected', () => {
  const host = createHost()
  const match = startMatch(host)
  playTurn(host, match, table(1, 1))
  host.balance = 100000
  const first = host.externalInvoice(2000)
  const other = host.externalInvoice(2000)
  cutOffDuringPayment(host, match, first)

  // The money left; the backend only knows that a payment was started.
  assert.deepEqual(outgoing(host, 'payout').map(payment => payment.bolt11), [first])
  assert.deepEqual(payoutsOf(host, match).map(row => [row.bolt11, row.status]), [[first, 'bound'], [first, 'started']])
  assert.equal(host.row('lnpool_matches', match.matchId).payout_status, 'paying')
  assert.equal(host.ok('getPublicLnpoolMatch', {matchId: match.matchId}).match.settlement.status, 'paying')

  // Straight afterwards nothing is asked of LNbits at all.
  const soon = hostCallsOf(host, () => {
    assert.equal(host.ok('claimLnpoolPayout', {...match[1], destination: other}).settling, true)
  })
  assert.deepEqual(soon.filter(name => name.startsWith('wallet.')), [])

  // A payment cannot take this long. Nobody is told "sending" any more: the
  // page gets a state it can act on, without anyone having claimed again.
  host.now += 30
  const stale = host.ok('syncLnpoolMatch', {...match[1]}).match.settlement
  assert.equal(stale.status, 'unconfirmed')
  assert.match(stale.detail, /never recorded/)

  // The next claim asks LNbits about the same invoice, in one call, with no
  // lock and no new invoice. It names another wallet; that is ignored.
  // LNbits answers from the payment it has.
  const asking = hostCallsOf(host, () => {
    assert.equal(claim(host, match, 1, other).settlement.status, 'paid')
  })
  assert.deepEqual(asking.filter(name => name.startsWith('wallet.')), ['wallet.payInvoice'])
  assert.deepEqual(outgoing(host, 'payout').map(payment => payment.bolt11), [first])
  assert.equal(outgoing(host, 'lock').length, 1)
  assert.equal(host.invoice(other).payment, '', 'LNbits was never asked to pay another invoice')
  assert.deepEqual(payoutsOf(host, match).map(row => [row.bolt11, row.status]), [[first, 'bound'], [first, 'started'], [first, 'paid']])
})

test('a cut-off payout from a wallet it emptied stays unconfirmed, and bound, until LNbits can answer', () => {
  // The second real case: a 10 sat prize, no hall fee, a little spare in the wallet.
  const host = createHost({float: 3})
  const hall = openHall(host, {feePercent: 0, minStake: 1})
  const match = startMatch(host, {stake: 5, hall})
  playTurn(host, match, table(1, 1))
  const first = host.externalInvoice(10)
  cutOffDuringPayment(host, match, first)
  assert.equal(host.balance, 3)
  assert.equal(host.invoice(first).paid, true)

  // LNbits checks the balance before it looks for the payment, so asking is
  // refused. That proves nothing, and frees nothing.
  for (let n = 0; n < 3; n += 1) {
    host.now += 30
    const other = host.externalInvoice(10)
    const unknown = claim(host, match, 1, other)
    assert.equal(unknown.settlement.status, 'unconfirmed')
    assert.match(unknown.settlement.detail, /never recorded.*Last check: Insufficient balance/)
    assert.equal(host.invoice(other).payment, '')
  }
  assert.equal(outgoing(host, 'payout').length, 1)
  assert.deepEqual(payoutsOf(host, match).map(row => row.status), ['bound', 'started', 'refused'], 'the same refusal three times is one row')

  // With the prize and the reserve in the wallet again LNbits gets as far as
  // its own record. Nothing is sent.
  host.balance = 12
  host.now += 30
  const found = claim(host, match, 1, host.externalInvoice(10))
  assert.equal(found.settlement.status, 'paid')
  assert.equal(host.balance, 12)
  assert.deepEqual(outgoing(host, 'payout').map(payment => payment.bolt11), [first])
})

test('any number of claims asking about a cut-off payment at once pay nothing more', () => {
  const host = createHost()
  const match = startMatch(host)
  playTurn(host, match, table(1, 1))
  host.balance = 100000
  const first = host.externalInvoice(2000)
  cutOffDuringPayment(host, match, first)
  host.now += 30

  // Each claim, just before it records that it is about to ask, is overtaken
  // by another one that runs start to finish. None of them sees another one
  // running, so all four call LNbits, each naming a different wallet.
  const others = [1, 2, 3, 4].map(() => host.externalInvoice(2000))
  const answers = []
  let depth = 0
  host.hostCalls.length = 0
  host.onHostCall = name => {
    if (name !== 'system.id' || depth >= 3) return
    depth += 1
    answers.push(host.call('claimLnpoolPayout', {...match[1], destination: others[depth]}))
  }
  answers.push(host.call('claimLnpoolPayout', {...match[1], destination: others[0]}))
  host.onHostCall = null

  assert.equal(depth, 3)
  assert.equal(host.hostCalls.filter(name => name === 'wallet.payInvoice').length, 4)
  assert.deepEqual(answers.map(answer => answer.ok && answer.data.match.settlement.status), ['paid', 'paid', 'paid', 'paid'])
  assert.deepEqual(outgoing(host, 'payout').map(payment => payment.bolt11), [first])
  for (const other of others) assert.equal(host.invoice(other).payment, '')
  assert.equal(host.balance, 100000 - 2000)
})

test('the same holds while the first payment is still being made', () => {
  const host = createHost()
  const match = startMatch(host)
  playTurn(host, match, table(1, 1))
  host.balance = 100000
  const first = host.externalInvoice(2000)
  const other = host.externalInvoice(2000)
  assert.equal(host.ok('claimLnpoolPayout', {...match[1], destination: first}).bound, true)
  // While LNbits is paying, a second claim gets past the "somebody is paying"
  // pause (as if the first had been running for a long time) and calls too.
  let nested = null
  host.beforePay = bolt11 => {
    if (host.invoice(bolt11).internal || nested) return
    host.now += 30
    nested = host.call('claimLnpoolPayout', {...match[1], destination: other})
  }
  const outer = host.ok('claimLnpoolPayout', {...match[1], destination: ''})
  host.beforePay = null
  assert.equal(nested.data.match.settlement.status, 'pending', 'LNbits told the second call a payment was in flight')
  assert.equal(outer.match.settlement.status, 'paid')
  assert.deepEqual(outgoing(host, 'payout').map(payment => payment.bolt11), [first])
  assert.equal(host.invoice(other).payment, '')
})

test('a claim that is already late does not take the lock, and a slow address costs nothing', () => {
  const realNow = Date.now
  let skew = 0
  Date.now = () => realNow() + skew
  try {
    const host = createHost()
    const match = startMatch(host)
    playTurn(host, match, table(1, 1))

    // LNbits is so busy that checking the invoice takes three seconds.
    const invoice = host.externalInvoice(2000)
    host.onHostCall = name => {
      if (name === 'lightning.validateInvoice') skew += 3000
    }
    assert.match(host.call('claimLnpoolPayout', {...match[1], destination: invoice}).error, /LNbits is busy.*Nothing was sent/)
    host.onHostCall = null
    assert.equal(host.payments.length, 0, 'not even the lock')
    assert.equal(payoutsOf(host, match).length, 0)

    // A Lightning address that takes four seconds to answer: the call that
    // asks it does nothing else, so there is nothing for it to be late for.
    host.lnurl.set('slow@wallet.example', amount => {
      skew += 4000
      return host.externalInvoice(amount)
    })
    const resolved = host.ok('claimLnpoolPayout', {...match[1], destination: 'slow@wallet.example'})
    assert.ok(resolved.resolved)
    assert.equal(host.payments.length, 0)
    // The next call starts with a fresh clock and records the invoice.
    assert.equal(host.ok('claimLnpoolPayout', {...match[1], destination: resolved.resolved}).bound, true)
    assert.equal(claim(host, match, 1, '').settlement.status, 'paid')
  } finally {
    Date.now = realNow
  }
})

test('a payment the node failed is sealed by LNbits before another invoice is accepted', () => {
  const host = createHost()
  const match = startMatch(host)
  playTurn(host, match, table(1, 1))
  const first = host.externalInvoice(2000)
  const other = host.externalInvoice(2000)
  host.failPayments = target => (target.internal ? null : 'No route found.')
  const failed = claim(host, match, 1, first)
  assert.equal(failed.settlement.status, 'failed')
  assert.match(failed.settlement.detail, /^Payment failed: No route found/)
  assert.equal(host.balance, FLOAT + 2000)
  host.failPayments = null

  // One report of failure is not enough to let go of the invoice. The next
  // claim asks LNbits about it again, whatever destination it names.
  const sealed = claim(host, match, 1, other)
  assert.equal(sealed.settlement.status, 'released')
  assert.match(sealed.settlement.detail, /retrying is not possible/)
  assert.equal(outgoing(host, 'payout').length, 0)
  assert.deepEqual(payoutsOf(host, match).map(row => [row.bolt11, row.status]), [[first, 'bound'], [first, 'failed'], [first, 'dead']])
  assert.match(host.call('claimLnpoolPayout', {...match[1], destination: ''}).error, /Enter a Lightning address/)

  // LNbits holds a failed payment of the first invoice and will never send
  // it again. Now another one can be recorded, behind the lock the paid
  // event left when the match started.
  const calls = hostCallsOf(host, () => {
    assert.equal(host.ok('claimLnpoolPayout', {...match[1], destination: other}).bound, true)
  })
  assert.deepEqual(calls.filter(name => name === 'wallet.payInvoice').length, 1)
  assert.equal(outgoing(host, 'lock').length, 2)
  assert.equal(claim(host, match, 1, '').settlement.status, 'paid')
  assert.deepEqual(outgoing(host, 'payout').map(payment => payment.bolt11), [other])
  assert.equal(host.invoice(first).paid, false)

  // A call for the first invoice that was still on its way is refused by
  // LNbits, which is what makes letting go of it safe.
  assert.equal(host.invoice(first).payment, 'failed')
})

test('a payment reported failed that the node paid after all is found, and nothing else is paid', () => {
  const host = createHost()
  const match = startMatch(host)
  playTurn(host, match, table(1, 1))
  const first = host.externalInvoice(2000)
  const other = host.externalInvoice(2000)
  host.failPayments = target => (target.internal ? null : 'timeout')
  assert.equal(claim(host, match, 1, first).settlement.status, 'failed')
  host.failPayments = null

  host.nodeStatus = () => 'pending' // the node does not know yet
  assert.equal(claim(host, match, 1, other).settlement.status, 'unconfirmed')
  host.nodeStatus = () => 'success'
  assert.equal(claim(host, match, 1, other).settlement.status, 'paid')
  assert.deepEqual(outgoing(host, 'payout').map(payment => payment.bolt11), [first])
  assert.equal(host.invoice(other).payment, '')
})

test('calls made within the same second are read in the order they were made', () => {
  const host = createHost()
  // The host's ids are random: here they come out in descending order.
  let ids = 900
  host.onHostCall = name => {
    if (name === 'system.id') ids -= 1
  }
  const realId = host.nextId
  host.nextId = prefix => prefix + '_' + String(ids).padStart(6, '0')
  const match = startMatch(host)
  playTurn(host, match, table(1, 1))
  const first = host.externalInvoice(2000)
  host.failPayments = target => (target.internal ? null : 'timeout')
  assert.equal(claim(host, match, 1, first).settlement.status, 'failed')
  host.failPayments = null
  host.nodeStatus = () => 'pending'
  // Asked again at once: LNbits cannot say. That is the latest word, not the failure before it.
  assert.equal(claim(host, match, 1, '').settlement.status, 'unconfirmed')
  assert.deepEqual(payoutsOf(host, match).map(row => row.status), ['bound', 'failed', 'unknown'])
  host.nextId = realId
})

test('an error LNbits is not known to raise before sending is not read as "nothing was sent"', () => {
  const host = createHost()
  const match = startMatch(host)
  playTurn(host, match, table(1, 1))
  const first = host.externalInvoice(2000)
  const other = host.externalInvoice(2000)
  host.refusePayments = target => (target.internal ? null : 'Something new went wrong.')
  const odd = claim(host, match, 1, first)
  assert.equal(odd.settlement.status, 'unconfirmed')
  assert.match(odd.settlement.detail, /Something new went wrong/)
  host.refusePayments = null
  assert.equal(claim(host, match, 1, other).settlement.status, 'paid')
  assert.deepEqual(outgoing(host, 'payout').map(payment => payment.bolt11), [first])
})

test('a paid match stays paid when a late call is refused', () => {
  const host = createHost()
  const match = startMatch(host)
  playTurn(host, match, table(1, 1))
  const first = host.externalInvoice(2000)
  host.invoice(first).leavePending = true
  assert.equal(claim(host, match, 1, first).settlement.status, 'pending')
  // The payment went through and emptied the wallet. Asked again, LNbits
  // answers "Insufficient balance" before it looks at the payment.
  host.balance = 50
  host.now += 30
  const unanswered = claim(host, match, 1, '')
  assert.equal(unanswered.settlement.status, 'pending')
  host.balance = 5000
  host.now += 30
  assert.equal(claim(host, match, 1, host.externalInvoice(2000)).settlement.status, 'paid')
  assert.equal(outgoing(host, 'payout').length, 1)
  assert.equal(host.balance, 5000)
  // Afterwards a refused call cannot take that back.
  host.balance = 0
  host.rawSet('lnpool_matches', {...host.row('lnpool_matches', match.matchId), payout_status: 'pending'})
  assert.equal(claim(host, match, 1, '').settlement.status, 'paid')
})

test('"sending" is never shown for longer than a payment can take', () => {
  const host = createHost()
  const match = startMatch(host)
  playTurn(host, match, table(1, 1))
  const invoice = host.externalInvoice(2000)

  // Recorded, and then the page went away before paying.
  assert.equal(host.ok('claimLnpoolPayout', {...match[1], destination: invoice}).match.settlement.status, 'paying')
  host.now += 30
  const left = host.ok('getPublicLnpoolMatch', {matchId: match.matchId}).match.settlement
  assert.equal(left.status, 'unconfirmed')
  assert.match(left.detail, /no payment has been made yet/)
  assert.equal(host.ok('listLnpoolMatches', {}).matches.find(item => item.id === match.matchId).payoutStatus, 'unconfirmed')

  // In flight according to LNbits, and nobody has asked for two minutes.
  host.invoice(invoice).stayPending = true
  assert.equal(claim(host, match, 1, '').settlement.status, 'pending')
  host.now += 60
  assert.equal(host.ok('getPublicLnpoolMatch', {matchId: match.matchId}).match.settlement.status, 'pending')
  host.now += 90
  assert.equal(host.ok('getPublicLnpoolMatch', {matchId: match.matchId}).match.settlement.status, 'unconfirmed')
  // Asking again is always possible, and is answered from LNbits.
  assert.equal(claim(host, match, 1, '').settlement.status, 'pending')
})

// ── Matches settled halfway by earlier versions ─────────────────────────────

test('the match the two-call build left stuck is settled by asking about its invoice', () => {
  // Exactly what the real instance holds: an invoice refused for the reserve,
  // a second one recorded after a top-up, its payment cut off, a follow-up cut
  // off as well, and a lock spent by a third that never wrote its row.
  const host = createHost()
  const match = startMatch(host, {stake: 5, hall: openHall(host, {feePercent: 0, minStake: 1})})
  playTurn(host, match, table(2, 2))
  const a = host.externalInvoice(10)
  const b = host.externalInvoice(10)
  const spent = () => {
    host.ok('createLnpoolMatch', {hallId: match.hall.id, name: 'x', stake: 5})
    const lock = host.rows('lnpool_matches').at(-1).lock_bolt11
    host.invoice(lock).paid = true
    return lock
  }
  host.invoice(host.row('lnpool_matches', match.matchId).lock_bolt11).paid = true
  const row = (n, status, bolt11, detail, locks) => host.rawSet('lnpool_payouts', {
    id: match.matchId + '-' + n, match_id: match.matchId, n, seat: 2, amount: 10, bolt11, payment_hash: host.invoice(bolt11).paymentHash,
    status, detail, next_lock: locks, created_at: host.now - 300 + n, updated_at: host.now - 300 + n
  })
  row(1, 'bound', a, '', spent() + ' ' + spent())
  row(2, 'refused', a, 'You must reserve at least (2  sat) to cover potential routing fees.', spent())
  row(3, 'bound', b, '', spent() + ' ' + spent())
  row(4, 'started', b, '', spent())
  row(5, 'started', b, '', spent())
  host.rawSet('lnpool_matches', {...host.row('lnpool_matches', match.matchId), payout_seat: 2, payout_amount: 10, payout_status: 'paying', updated_at: host.now - 290})
  // The payment of B went through.
  host.invoice(b).payment = 'success'
  host.invoice(b).paid = true
  host.balance = 30
  host.payments.length = 0

  assert.equal(host.ok('syncLnpoolMatch', {...match[2]}).match.settlement.status, 'unconfirmed', 'the page no longer says "sending"')
  const calls = hostCallsOf(host, () => {
    assert.equal(claim(host, match, 2, host.externalInvoice(10)).settlement.status, 'paid')
  })
  assert.deepEqual(calls.filter(name => name.startsWith('wallet.')), ['wallet.payInvoice'], 'one question to LNbits: no lock, no new invoice')
  assert.equal(host.payments.length, 0, 'nothing was sent')
  assert.equal(host.invoice(a).payment, '')
  assert.equal(host.balance, 30)
})

test('rows from before invoices were recorded separately still bind their invoice', () => {
  const host = createHost()
  const match = startMatch(host)
  playTurn(host, match, table(1, 1))
  const x = host.externalInvoice(2000)
  const other = host.externalInvoice(2000)
  host.invoice(host.row('lnpool_matches', match.matchId).lock_bolt11).paid = true
  for (const [n, status] of [[1, 'started'], [2, 'refused'], [3, 'refused']]) {
    host.rawSet('lnpool_payouts', {
      id: match.matchId + '-' + n, match_id: match.matchId, n, seat: 1, amount: 2000, bolt11: x, payment_hash: host.invoice(x).paymentHash,
      status, detail: status === 'refused' ? 'Insufficient balance.' : '', next_lock: '', created_at: host.now - 100 + n, updated_at: host.now - 100 + n
    })
  }
  host.rawSet('lnpool_matches', {...host.row('lnpool_matches', match.matchId), payout_status: 'unconfirmed'})
  host.now += 10
  assert.equal(claim(host, match, 1, other).settlement.status, 'paid')
  assert.deepEqual(outgoing(host, 'payout').map(payment => payment.bolt11), [x])
  assert.equal(host.invoice(other).payment, '')
})

test('a match bound by the first build retries its own invoice and takes no other', () => {
  const host = createHost()
  const match = startMatch(host)
  playTurn(host, match, table(1, 1))
  const bound = host.externalInvoice(2000)
  const row = host.row('lnpool_matches', match.matchId)
  host.invoice(row.lock_bolt11).paid = true
  host.rawSet('lnpool_matches', {
    ...row, payout_seat: 1, payout_amount: 2000, payout_bolt11: bound, payout_hash: host.invoice(bound).paymentHash,
    payout_status: 'failed', note: 'Payout failed: You must reserve at least (20  sat) to cover potential routing fees.'
  })
  host.balance = 2000 // still short of the reserve
  assert.equal(claim(host, match, 1, host.externalInvoice(2000)).settlement.status, 'failed')
  host.balance = 2100
  const other = host.externalInvoice(2000)
  const paid = claim(host, match, 1, other)
  assert.equal(paid.settlement.status, 'paid')
  assert.equal(paid.note, '')
  assert.deepEqual(outgoing(host, 'payout').map(payment => payment.bolt11), [bound])
  assert.equal(payoutsOf(host, match).length, 0)

  // Its status is never taken back by a later refusal.
  host.balance = 0
  host.rawSet('lnpool_matches', {...host.row('lnpool_matches', match.matchId), payout_status: 'paying'})
  host.refusePayments = target => {
    host.rawSet('lnpool_matches', {...host.row('lnpool_matches', match.matchId), payout_status: 'paid'})
    return target.internal ? null : 'Insufficient balance.'
  }
  assert.equal(claim(host, match, 1, '').settlement.status, 'paid')
})

// ── Locks, limits and the operator's view ───────────────────────────────────

test('the paid event that starts a match leaves the lock a second destination would need', () => {
  const host = createHost()
  const hall = openHall(host)
  const created = host.ok('createLnpoolMatch', {hallId: hall.id, name: 'Ana', stake: 1000})
  const first = hostCallsOf(host, () => host.payBuyIn(created.paymentRequest))
  assert.deepEqual(first.filter(name => name.startsWith('wallet.')), [], 'nothing is asked of the funding source for the first seat')
  const joined = host.ok('joinLnpoolMatch', {matchId: created.match.id, name: 'Bo'})
  const second = hostCallsOf(host, () => host.payBuyIn(joined.paymentRequest))
  assert.deepEqual(second.filter(name => name.startsWith('wallet.')), ['wallet.createInvoicePublic'])
  assert.ok(second.indexOf('wallet.createInvoicePublic') > second.lastIndexOf('websocket.publish'), 'only after the match has started and been announced')
  const locks = host.rows('lnpool_payouts').filter(row => row.status === 'lock')
  assert.deepEqual(locks.map(row => row.id), [created.match.id + '-lock-' + joined.playerId])
  assert.ok(host.invoice(locks[0].next_lock).internal)

  // If the funding source cannot make it, the match starts all the same.
  const other = createHost()
  const again = other.ok('createLnpoolMatch', {hallId: openHall(other).id, name: 'Ana', stake: 1000})
  other.payBuyIn(again.paymentRequest)
  const late = other.ok('joinLnpoolMatch', {matchId: again.match.id, name: 'Bo'})
  other.failInvoices = true
  assert.equal(other.payBuyIn(late.paymentRequest).data.matchStatus, 'active')
  assert.equal(other.rows('lnpool_payouts').length, 0)
})

test('a refund has no spare lock, so the binding makes one once it is safely recorded', () => {
  const host = createHost()
  const hall = openHall(host)
  const created = host.ok('createLnpoolMatch', {hallId: hall.id, name: 'Ana', stake: 1000})
  const creds = {matchId: created.match.id, playerId: created.playerId, token: created.token}
  host.payBuyIn(created.paymentRequest)
  host.ok('cancelLnpoolMatch', creds)
  const calls = hostCallsOf(host, () => {
    assert.equal(host.ok('claimLnpoolPayout', {...creds, destination: host.externalInvoice(1000)}).bound, true)
  })
  const wallet = calls.filter(name => name.startsWith('wallet.'))
  assert.deepEqual(wallet, ['wallet.payInvoice', 'wallet.createInvoicePublic'], 'the lock first, the spare afterwards')
  assert.ok(calls.indexOf('wallet.createInvoicePublic') > calls.indexOf('storage.set'), 'after the invoice was recorded')
  const [bound] = host.rows('lnpool_payouts').filter(row => row.status === 'bound')
  assert.ok(host.invoice(bound.next_lock).internal)
})

test('asking again and again while the wallet is short does not use up the calls a payout is allowed', () => {
  const {host, match} = fundedOnlyByThePot()
  const invoice = host.externalInvoice(9)
  host.hostCalls.length = 0
  for (let n = 0; n < 100; n += 1) {
    host.now += 10
    assert.equal(claim(host, match, 1, invoice).settlement.status, 'unsent')
  }
  assert.deepEqual(payoutsOf(host, match).map(row => row.status), ['bound', 'refused'], 'a hundred identical refusals are one row')
  assert.equal(host.hostCalls.filter(name => name === 'wallet.payInvoice').length, 101, 'the lock, then every one of them asked LNbits')

  // A second press straight after a refusal, or a second tab, asks nothing.
  const twice = hostCallsOf(host, () => {
    assert.equal(claim(host, match, 1, invoice).settlement.status, 'unsent')
    assert.equal(claim(host, match, 1, invoice).settlement.status, 'unsent')
  })
  assert.deepEqual(twice.filter(name => name.startsWith('wallet.')), [])

  // So the wallet can still be topped up and the prize paid, however long it took.
  host.balance += 2
  host.now += 10
  assert.equal(claim(host, match, 1, invoice).settlement.status, 'paid')
  assert.deepEqual(payoutsOf(host, match).map(row => row.status), ['bound', 'refused', 'paid'])
})

test('a retry of an unsent payout that is cut off while paying is not left reading "nothing was sent"', () => {
  const {host, match} = fundedOnlyByThePot()
  const invoice = host.externalInvoice(9)
  assert.equal(claim(host, match, 1, invoice).settlement.status, 'unsent')
  // Topped up; the retry pays, and LNbits stops the invocation before it hears.
  host.balance += 5
  host.now += 10
  host.cutOff = target => !target.internal
  assert.deepEqual(host.call('claimLnpoolPayout', {...match[1], destination: ''}), {ok: false, error: 'wasm trap: interrupt'})
  host.cutOff = null
  assert.equal(host.invoice(invoice).paid, true)
  // Nobody has claimed again, and the pages already know better.
  assert.equal(host.ok('getPublicLnpoolMatch', {matchId: match.matchId}).match.settlement.status, 'paying')
  host.now += 30
  assert.equal(host.ok('getPublicLnpoolMatch', {matchId: match.matchId}).match.settlement.status, 'unconfirmed')
  assert.equal(host.ok('listLnpoolMatches', {}).matches.find(item => item.id === match.matchId).payoutStatus, 'unconfirmed')
})

test('a call cut off after the same refusal as before leaves its row, on the side of caution', () => {
  const {host, match} = fundedOnlyByThePot()
  const invoice = host.externalInvoice(9)
  assert.equal(claim(host, match, 1, invoice).settlement.status, 'unsent')
  host.now += 10
  // The answer came, and the invocation was stopped before it could act on it.
  host.onHostCall = name => {
    if (name === 'storage.delete') throw new Error('wasm trap: interrupt')
  }
  assert.equal(host.call('claimLnpoolPayout', {...match[1], destination: ''}).ok, false)
  host.onHostCall = null
  assert.deepEqual(payoutsOf(host, match).map(row => row.status), ['bound', 'refused', 'started'])
  host.now += 30
  assert.equal(host.ok('syncLnpoolMatch', {...match[1]}).match.settlement.status, 'unconfirmed')
})

test('the number of calls to pay one invoice is bounded', () => {
  const host = createHost()
  const match = startMatch(host)
  playTurn(host, match, table(1, 1))
  const invoice = host.externalInvoice(2000)
  // A different answer every time, none of them a payment.
  let n = 0
  host.refusePayments = target => (target.internal ? null : 'The time limit of ' + (n += 1) + ' seconds between payments has been reached.')
  for (let tries = 0; tries < 40; tries += 1) {
    host.now += 10
    assert.equal(claim(host, match, 1, invoice).settlement.status, 'unsent')
  }
  host.now += 10
  assert.match(host.call('claimLnpoolPayout', {...match[1], destination: invoice}).error, /too many times/)
  assert.equal(payoutsOf(host, match).length, 41)
  assert.equal(outgoing(host, 'payout').length, 0)
})

test('the operator sees the recorded invoice and every call made to pay it', () => {
  const {host, match} = fundedOnlyByThePot()
  const first = host.externalInvoice(9)
  claim(host, match, 1, first)
  host.balance += 2
  host.now += 10
  claim(host, match, 1, '')
  const detail = host.ok('getLnpoolMatchAdmin', {matchId: match.matchId})
  assert.deepEqual(detail.payouts.map(row => [row.status, row.invoice, row.amount]), [['bound', first, 9], ['refused', first, 9], ['paid', first, 9]])
  assert.match(detail.payouts[1].detail, /reserve/)
  assert.equal(detail.match.payoutStatus, 'paid')
  const listed = host.ok('listLnpoolMatches', {}).matches.find(item => item.id === match.matchId)
  assert.equal(listed.payoutStatus, 'paid')
  // Neither the page nor the list ever carries a lock invoice.
  const locks = host.rows('lnpool_payouts').flatMap(row => row.next_lock.split(' ')).filter(Boolean)
  assert.ok(locks.length > 0)
  for (const lock of locks) assert.ok(!JSON.stringify(detail).includes(lock))
})

test('without a usable lock nothing is paid', () => {
  const host = createHost()
  const match = startMatch(host)
  playTurn(host, match, table(1, 1))
  host.now += 3601 // the lock invoice has expired
  const invoice = host.externalInvoice(2000)
  const result = host.call('claimLnpoolPayout', {...match[1], destination: invoice})
  assert.equal(result.ok, false)
  assert.match(result.error, /Automatic payout is not available/)
  assert.equal(host.payments.length, 0)
  assert.equal(host.row('lnpool_matches', match.matchId).payout_bolt11, '')

  // Same when the owner never authorized background payments.
  const other = createHost()
  const second = startMatch(other)
  playTurn(other, second, table(1, 1))
  other.refusePayments = () => 'missing wallet background grant'
  assert.match(other.call('claimLnpoolPayout', {...second[1], destination: other.externalInvoice(2000)}).error, /background grant/)
  assert.equal(other.payments.length, 0)
})

test('conceding gives the match to the other player', () => {
  const host = createHost()
  const match = startMatch(host)
  const view = host.ok('concedeLnpoolMatch', {...match[1]}).match
  assert.equal(view.status, 'finished')
  assert.equal(view.winner, 2)
  assert.match(view.note, /Ana conceded/)
  assert.match(host.call('concedeLnpoolMatch', {...match[2]}).error, /in play/)
  host.claim({...match[2], destination: host.externalInvoice(2000)})
  assert.equal(host.balance, FLOAT)
})

// ── Cancelling ──────────────────────────────────────────────────────────────

test('the first player can cancel before anyone joins and take the buy-in back', () => {
  const host = createHost()
  const hall = openHall(host)
  const created = host.ok('createLnpoolMatch', {hallId: hall.id, name: 'Ana', stake: 1000})
  const creds = {matchId: created.match.id, playerId: created.playerId, token: created.token}
  host.payBuyIn(created.paymentRequest)

  const cancelled = host.ok('cancelLnpoolMatch', creds).match
  assert.equal(cancelled.status, 'cancelled')
  assert.deepEqual(cancelled.settlement, {seat: 1, amount: 1000, reason: 'refund', status: ''})
  assert.match(host.call('joinLnpoolMatch', {matchId: creds.matchId, name: 'Bo'}).error, /not open/)

  assert.match(host.call('claimLnpoolPayout', {...creds, destination: host.externalInvoice(2000)}).error, /exactly 1000 sats/)
  host.claim({...creds, destination: host.externalInvoice(1000)})
  assert.equal(host.balance, FLOAT)
  assert.equal(outgoing(host, 'payout').length, 1)
})

test('a match with two paid players cannot be cancelled', () => {
  const host = createHost()
  const match = startMatch(host)
  assert.match(host.call('cancelLnpoolMatch', {...match[1]}).error, /before an opponent/)
  assert.match(host.call('cancelLnpoolMatch', {...match[2]}).error, /before an opponent/)
})

// ── Operator ────────────────────────────────────────────────────────────────

test('a match the operator settled by hand cannot be claimed afterwards', () => {
  const host = createHost()
  const match = startMatch(host)
  playTurn(host, match, table(1, 1))
  const resolved = host.ok('resolveLnpoolMatch', {matchId: match.matchId, note: 'Paid Ana in cash.'}).match
  assert.equal(resolved.status, 'resolved')
  assert.match(host.call('claimLnpoolPayout', {...match[1], destination: host.externalInvoice(2000)}).error, /nothing for this seat/)
  assert.equal(host.payments.length, 0)
  assert.equal(host.ok('listLnpoolMatches', {status: 'resolved'}).matches[0].note, 'Paid Ana in cash.')
})

test('state changes are announced on the match channel', () => {
  const host = createHost()
  const match = startMatch(host)
  host.published.length = 0
  playTurn(host, match, table(2))
  assert.deepEqual(host.published.map(message => [message.itemId, message.data.t]), [[match.matchId, 'sync'], [match.matchId, 'sync']])
  assert.ok(!JSON.stringify(host.published).includes(match[1].token))
})

// ── Cost ────────────────────────────────────────────────────────────────────
// LNbits meters every call. What costs fuel is crossing into the host, so
// these keep the number of crossings from growing with the data.

test('unpaid matches cannot crowd paid ones out of the lobby', () => {
  const host = createHost()
  const hall = openHall(host)
  const paid = host.ok('createLnpoolMatch', {hallId: hall.id, name: 'Ana', stake: 1000})
  host.payBuyIn(paid.paymentRequest)
  // Created later, so they sort ahead of the paid match.
  for (let n = 0; n < 60; n += 1) {
    host.now += 1
    host.ok('createLnpoolMatch', {hallId: hall.id, name: 'Nobody', stake: 100})
  }
  assert.deepEqual(host.ok('getPublicLnpoolHall', {hallId: hall.id}).matches.map(match => match.id), [paid.match.id])
})

test('the lobby is one bounded query, however many matches are open', () => {
  const host = createHost()
  const hall = openHall(host)
  for (let n = 0; n < 55; n += 1) {
    host.now += 1
    host.payBuyIn(host.ok('createLnpoolMatch', {hallId: hall.id, name: 'Ana ' + n, stake: 100 + n}).paymentRequest)
  }
  let lobby
  const calls = hostCallsOf(host, () => {
    lobby = host.ok('getPublicLnpoolHall', {hallId: hall.id}).matches
  })
  assert.deepEqual(calls, ['storage.get', 'storage.find'])
  assert.equal(lobby.length, 50)
  assert.equal(lobby[0].host, 'Ana 54', 'newest first')
})

test('the owner list is two queries, however many matches there are', () => {
  const host = createHost()
  const hall = openHall(host)
  for (let n = 0; n < 30; n += 1) {
    host.now += 1
    host.payBuyIn(host.ok('createLnpoolMatch', {hallId: hall.id, name: 'Ana', stake: 100 + n}).paymentRequest)
  }
  let listed
  const calls = hostCallsOf(host, () => {
    listed = host.ok('listLnpoolMatches', {page: 2, rowsPerPage: 20})
  })
  assert.deepEqual(calls, ['storage.find', 'storage.find', 'system.now'])
  assert.equal(listed.total, 30)
  assert.equal(listed.matches.length, 10)
})

test('recording an invoice asks nothing of the funding source, and paying it is one call', () => {
  const host = createHost()
  const match = startMatch(host)
  playTurn(host, match, table(1, 1))
  host.lnurl.set('ana@wallet.example', amount => host.externalInvoice(amount))

  // Asking the address is a call of its own and writes nothing.
  let resolved
  const asking = hostCallsOf(host, () => {
    resolved = host.ok('claimLnpoolPayout', {...match[1], destination: 'ana@wallet.example'}).resolved
  })
  assert.deepEqual(asking.filter(name => name.startsWith('wallet.')), ['wallet.fetchLnurlInvoice'])
  assert.ok(!asking.includes('storage.set'))

  // Recording pays the lock and writes; no invoice is created, no address asked.
  const binding = hostCallsOf(host, () => {
    assert.equal(host.ok('claimLnpoolPayout', {...match[1], destination: resolved}).bound, true)
  })
  assert.deepEqual(binding.filter(name => name.startsWith('wallet.')), ['wallet.payInvoice'])
  assert.deepEqual(binding.slice(binding.indexOf('wallet.payInvoice') + 1, binding.indexOf('storage.set')), ['storage.get', 'storage.find'], 'two reads between taking the lock and recording')
  assert.equal(outgoing(host, 'payout').length, 0)

  // Paying reads storage, records that it is about to pay, and pays.
  const paying = hostCallsOf(host, () => {
    assert.equal(host.ok('claimLnpoolPayout', {...match[1], destination: ''}).match.settlement.status, 'paid')
  })
  assert.deepEqual(paying.slice(0, paying.indexOf('wallet.payInvoice')), ['storage.get', 'storage.find', 'lightning.verifyPreimage', 'storage.find', 'system.now', 'system.id', 'storage.set'])
  assert.deepEqual(paying.filter(name => name.startsWith('wallet.')), ['wallet.payInvoice'])
  assert.equal(paying.filter(name => name === 'system.now').length, 1)
  assert.ok(paying.length <= 14, paying.join(', '))
})
