import assert from 'node:assert/strict'
import {test} from 'node:test'
import {FLOAT, createHost, openHall, playTurn, startMatch} from './helpers.mjs'

const table = (turn, winner = 0) => ({balls: [[750, 250]], turn, groups: 0, inHand: false, breaking: false, winner, shots: 1, last: null})
const outgoing = (host, kind) => host.payments.filter(payment => payment.kind === kind)
const attemptsOf = (host, match) => host.rows('lnpool_payouts').filter(row => row.match_id === match.matchId).sort((a, b) => a.n - b.n)
const claim = (host, match, seat, destination) => host.ok('claimLnpoolPayout', {...match[seat], destination}).match

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
  assert.equal(host.payments.length, 0, 'a refused claim pays nothing and does not use up the lock')

  const invoice = host.externalInvoice(2000)
  const paid = host.ok('claimLnpoolPayout', {...match[1], destination: invoice}).match
  assert.equal(paid.settlement.status, 'paid')
  assert.deepEqual(outgoing(host, 'payout').map(payment => [payment.bolt11, payment.amount]), [[invoice, 2000]])
  assert.equal(outgoing(host, 'lock').length, 1)
  assert.equal(host.balance, FLOAT)

  // Claiming again, with the same or another invoice, pays nothing more.
  host.balance = 5000
  for (const destination of [invoice, host.externalInvoice(2000), '']) {
    const again = host.ok('claimLnpoolPayout', {...match[1], destination}).match
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
  host.ok('claimLnpoolPayout', {...match[2], destination: host.externalInvoice(999)})
  assert.equal(host.balance, FLOAT + 1110 - 999)
})

test('a Lightning address is resolved to one invoice, which is then the only one paid', () => {
  const host = createHost()
  const match = startMatch(host)
  playTurn(host, match, table(1, 1))
  const issued = []
  host.lnurl.set('ana@wallet.example', amount => {
    issued.push(host.externalInvoice(amount))
    return issued.at(-1)
  })
  assert.match(host.call('claimLnpoolPayout', {...match[1], destination: 'nobody@wallet.example'}).error, /Could not get an invoice/)
  host.ok('claimLnpoolPayout', {...match[1], destination: 'ana@wallet.example'})
  host.ok('claimLnpoolPayout', {...match[1], destination: 'ana@wallet.example'})
  assert.equal(issued.length, 1, 'once bound, the address is not asked for another invoice')
  assert.deepEqual(outgoing(host, 'payout').map(payment => payment.bolt11), issued)
})

test('two claims racing for one match pay one invoice', () => {
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
  assert.equal(nested.data.settling, true, 'the loser of the race is told to wait, not paid')
  assert.equal(outer.match.settlement.status, 'paid')
  assert.deepEqual(outgoing(host, 'payout').map(payment => payment.bolt11), [first])
  assert.equal(host.invoice(second).paid, false)

  // The loser retries: it gets the bound invoice's status, not a payment.
  const retry = host.ok('claimLnpoolPayout', {...match[1], destination: second}).match
  assert.equal(retry.settlement.status, 'paid')
  assert.equal(outgoing(host, 'payout').length, 1)
})

test('a match that flips winner after it was paid still pays only once', () => {
  const host = createHost()
  const match = startMatch(host)
  playTurn(host, match, table(1, 1))
  host.balance = 100000
  host.ok('claimLnpoolPayout', {...match[1], destination: host.externalInvoice(2000)})
  // Two colluding players rewrite the result (a stale write landing late).
  host.rawSet('lnpool_matches', {...host.row('lnpool_matches', match.matchId), winner: 2, payout_status: '', payout_bolt11: '', payout_seat: 0})
  const second = host.externalInvoice(2000)
  const result = host.call('claimLnpoolPayout', {...match[2], destination: second})
  assert.equal(result.ok, true)
  assert.equal(result.data.match.settlement.status, 'paid', 'the recorded attempt says this match was paid')
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
  host.balance = 100000 // another pot's worth and more: LNbits answers about a payment only while the wallet could pay it again
  const pending = host.ok('claimLnpoolPayout', {...match[1], destination: invoice}).match
  assert.equal(pending.settlement.status, 'pending')
  // Asking again straight away does not bother LNbits.
  assert.equal(claim(host, match, 1, '').settlement.status, 'pending')
  assert.equal(attemptsOf(host, match).length, 1)
  host.now += 30
  const settled = host.ok('claimLnpoolPayout', {...match[1], destination: ''}).match
  assert.equal(settled.settlement.status, 'paid')
  assert.equal(outgoing(host, 'payout').length, 1)
  assert.deepEqual(attemptsOf(host, match).map(attempt => [attempt.bolt11, attempt.status]), [[invoice, 'pending'], [invoice, 'paid']])
})

// ── When a payout does not go through ───────────────────────────────────────
// Every call that pays a payout invoice is one recorded attempt. A new
// destination is accepted only when the attempts prove that no payment of an
// earlier invoice exists or can still be made.

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

test('a hall wallet holding only the pot cannot pay: nothing is sent and the prize stays claimable', () => {
  const {host, match} = fundedOnlyByThePot()
  const first = host.externalInvoice(9)
  const refused = claim(host, match, 1, first)
  assert.equal(refused.status, 'finished')
  assert.equal(refused.settlement.status, 'refused')
  assert.match(refused.settlement.detail, /^You must reserve at least \(2 +sat\) to cover potential routing fees/)
  assert.deepEqual([refused.settlement.seat, refused.settlement.amount], [1, 9], 'the prize has not changed')
  assert.equal(outgoing(host, 'payout').length, 0)
  assert.equal(host.balance, 10, 'the pot is untouched')
  assert.deepEqual(attemptsOf(host, match).map(attempt => [attempt.bolt11, attempt.status]), [[first, 'refused']])

  // Trying again changes nothing while the wallet is short, and does not
  // tie the match to anything.
  const second = host.externalInvoice(9)
  assert.equal(claim(host, match, 1, second).settlement.status, 'refused')
  assert.equal(claim(host, match, 1, first).settlement.status, 'refused')
  assert.equal(outgoing(host, 'payout').length, 0)

  // The operator tops the wallet up. The winner claims the full prize, to
  // whichever wallet they like.
  host.balance += 2
  const third = host.externalInvoice(9)
  const paid = claim(host, match, 1, third)
  assert.deepEqual(paid.settlement, {seat: 1, amount: 9, reason: 'prize', status: 'paid'})
  assert.deepEqual(outgoing(host, 'payout').map(payment => [payment.bolt11, payment.amount]), [[third, 9]])

  // And that is all this match ever pays.
  host.balance = 1000
  for (const destination of [first, second, host.externalInvoice(9), '']) {
    assert.equal(claim(host, match, 1, destination).settlement.status, 'paid')
  }
  assert.equal(outgoing(host, 'payout').length, 1)
  assert.equal(host.invoice(first).paid, false)
  assert.equal(host.invoice(second).paid, false)
})

test('a payout that is not sent leaves the match note alone', () => {
  const host = createHost({float: 0})
  const match = startMatch(host)
  host.ok('concedeLnpoolMatch', {...match[2]})
  const refused = claim(host, match, 1, host.externalInvoice(2000))
  assert.equal(refused.settlement.status, 'refused')
  assert.equal(refused.note, 'Bo conceded.')
  // Somebody watching is not told why.
  assert.equal(host.ok('getPublicLnpoolMatch', {matchId: match.matchId}).match.settlement.status, 'refused')
})

test('the prize is never reduced to fit the wallet', () => {
  const {host, match} = fundedOnlyByThePot()
  assert.match(host.call('claimLnpoolPayout', {...match[1], destination: host.externalInvoice(8)}).error, /exactly 9 sats/)
  claim(host, match, 1, host.externalInvoice(9))
  assert.match(host.call('claimLnpoolPayout', {...match[1], destination: host.externalInvoice(7)}).error, /exactly 9 sats/)
  assert.equal(outgoing(host, 'payout').length, 0)
})

test('a hall fee that covers the routing reserve needs no float', () => {
  const host = createHost({float: 0})
  const hall = openHall(host, {feePercent: 10})
  const match = startMatch(host, {stake: 100, hall})
  playTurn(host, match, table(1, 1))
  assert.equal(claim(host, match, 1, host.externalInvoice(180)).settlement.status, 'paid')
  assert.equal(host.balance, 20)
})

test('after a refusal, claims racing with different destinations pay one of them', () => {
  const {host, match} = fundedOnlyByThePot()
  claim(host, match, 1, host.externalInvoice(9))
  host.balance = 100000 // plenty, so only the lock stands between the wallet and a double payout
  const one = host.externalInvoice(9)
  const two = host.externalInvoice(9)

  // While the first new claim is inside its lock payment, a second one with
  // another destination runs start to finish.
  let nested = null
  host.beforePay = bolt11 => {
    if (host.invoice(bolt11).internal && !nested) nested = host.call('claimLnpoolPayout', {...match[1], destination: two})
  }
  const outer = claim(host, match, 1, one)
  host.beforePay = null

  assert.equal(nested.data.settling, true)
  assert.equal(outer.settlement.status, 'paid')
  assert.deepEqual(outgoing(host, 'payout').map(payment => payment.bolt11), [one])
  assert.equal(claim(host, match, 1, two).settlement.status, 'paid')
  assert.equal(host.invoice(two).paid, false)
  assert.equal(outgoing(host, 'payout').length, 1)
})

test('a refusal says nothing about a payment that is still out: the first invoice stays bound', () => {
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
  assert.equal(held.settlement.status, 'pending', 'a refused check does not turn a payment in flight into a failure')
  assert.deepEqual(attemptsOf(host, match).map(attempt => [attempt.bolt11, attempt.status]), [[first, 'pending'], [first, 'refused']])

  // Money comes back, the winner asks for another wallet: not accepted.
  host.balance = 100000
  host.now += 30
  assert.equal(claim(host, match, 1, other).settlement.status, 'pending')
  host.invoice(first).payment = 'success' // the first payment lands
  host.now += 30
  assert.equal(claim(host, match, 1, other).settlement.status, 'paid')
  assert.equal(host.invoice(other).paid, false)
  assert.equal(host.invoice(other).payment, '', 'LNbits was never asked to pay the second invoice')
})

test('an attempt that never reported keeps its invoice bound for good', () => {
  const host = createHost({float: 0})
  const match = startMatch(host)
  playTurn(host, match, table(1, 1))
  const first = host.externalInvoice(2000)
  const other = host.externalInvoice(2000)
  // An attempt that took its lock, recorded what it was about to pay and was
  // never heard from again. Its one call may still be on its way.
  const lock = host.row('lnpool_matches', match.matchId).lock_bolt11
  const nextLock = host.ok('createLnpoolMatch', {hallId: match.hall.id, name: 'x', stake: 1000}) && host.rows('lnpool_matches').at(-1).lock_bolt11
  host.invoice(lock).paid = true
  host.rawSet('lnpool_payouts', {
    id: match.matchId + '-1', match_id: match.matchId, n: 1, seat: 1, amount: 2000, bolt11: first,
    payment_hash: host.invoice(first).paymentHash, status: 'started', detail: '', next_lock: nextLock,
    created_at: host.now, updated_at: host.now
  })

  // Too soon: it may simply be running.
  assert.equal(host.call('claimLnpoolPayout', {...match[1], destination: other}).data.settling, true)
  host.now += 30
  // Followed up: the wallet is short, so this call is refused. That clears
  // nothing, because the silent attempt may still pay.
  const unknown = claim(host, match, 1, other)
  assert.equal(unknown.settlement.status, 'unconfirmed')
  assert.match(unknown.settlement.detail, /never recorded.*Last check: You must reserve/)
  host.balance += 100
  const paid = claim(host, match, 1, other)
  assert.equal(paid.settlement.status, 'paid')
  assert.deepEqual(outgoing(host, 'payout').map(payment => payment.bolt11), [first])
  assert.equal(host.invoice(other).payment, '')
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
  assert.equal(sealed.settlement.status, 'refused')
  assert.match(sealed.settlement.detail, /retrying is not possible/)
  assert.equal(outgoing(host, 'payout').length, 0)
  assert.deepEqual(attemptsOf(host, match).map(attempt => [attempt.bolt11, attempt.status]), [[first, 'failed'], [first, 'dead']])

  // LNbits holds a failed payment of the first invoice and will never send
  // it again. Now another one can be bound.
  assert.equal(claim(host, match, 1, other).settlement.status, 'paid')
  assert.deepEqual(outgoing(host, 'payout').map(payment => payment.bolt11), [other])
  assert.equal(host.invoice(first).paid, false)
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

test('an error LNbits is not known to raise before sending keeps the invoice bound', () => {
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
  assert.match(unanswered.note + JSON.stringify(host.ok('getLnpoolMatchAdmin', {matchId: match.matchId}).payouts), /Insufficient balance/)
  host.balance = 5000
  host.now += 30
  assert.equal(claim(host, match, 1, host.externalInvoice(2000)).settlement.status, 'paid')
  assert.equal(outgoing(host, 'payout').length, 1)
  assert.equal(host.balance, 5000)
})

test('a match bound by the previous version retries its own invoice and takes no other', () => {
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
  assert.equal(attemptsOf(host, match).length, 0)

  // Its status is never taken back by a later refusal.
  host.balance = 0
  host.rawSet('lnpool_matches', {...host.row('lnpool_matches', match.matchId), payout_status: 'paying'})
  host.refusePayments = target => {
    host.rawSet('lnpool_matches', {...host.row('lnpool_matches', match.matchId), payout_status: 'paid'})
    return target.internal ? null : 'Insufficient balance.'
  }
  assert.equal(claim(host, match, 1, '').settlement.status, 'paid')
})

test('the number of payout attempts is bounded', () => {
  const {host, match} = fundedOnlyByThePot()
  for (let n = 0; n < 20; n += 1) assert.equal(claim(host, match, 1, host.externalInvoice(9)).settlement.status, 'refused')
  assert.match(host.call('claimLnpoolPayout', {...match[1], destination: host.externalInvoice(9)}).error, /too many times/)
  assert.equal(attemptsOf(host, match).length, 20)
  assert.equal(outgoing(host, 'payout').length, 0)
})

test('the operator sees every payout attempt', () => {
  const {host, match} = fundedOnlyByThePot()
  const first = host.externalInvoice(9)
  claim(host, match, 1, first)
  host.balance += 2
  const second = host.externalInvoice(9)
  claim(host, match, 1, second)
  const detail = host.ok('getLnpoolMatchAdmin', {matchId: match.matchId})
  assert.deepEqual(detail.payouts.map(attempt => [attempt.n, attempt.status, attempt.invoice, attempt.amount]), [[1, 'refused', first, 9], [2, 'paid', second, 9]])
  assert.match(detail.payouts[0].detail, /reserve/)
  assert.equal(detail.match.payoutStatus, 'paid')
  const listed = host.ok('listLnpoolMatches', {}).matches.find(item => item.id === match.matchId)
  assert.equal(listed.payoutStatus, 'paid')
  // Neither the page nor the list ever carries a lock invoice.
  assert.ok(!JSON.stringify(detail).includes(host.rows('lnpool_payouts')[0].next_lock))
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
  host.ok('claimLnpoolPayout', {...match[2], destination: host.externalInvoice(2000)})
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
  host.ok('claimLnpoolPayout', {...creds, destination: host.externalInvoice(1000)})
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

const hostCallsOf = (host, run) => {
  host.hostCalls.length = 0
  run()
  return [...host.hostCalls]
}

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
  assert.deepEqual(calls, ['storage.find', 'storage.find'])
  assert.equal(listed.total, 30)
  assert.equal(listed.matches.length, 10)
})

test('a claim crosses into the host a fixed number of times and reads the clock once', () => {
  const host = createHost()
  const match = startMatch(host)
  playTurn(host, match, table(1, 1))
  const calls = hostCallsOf(host, () => {
    const claimed = host.ok('claimLnpoolPayout', {matchId: match.matchId, ...match[1], destination: host.externalInvoice(2000)})
    assert.equal(claimed.match.settlement.status, 'paid')
  })
  assert.equal(calls.filter(name => name === 'system.now').length, 1)
  assert.deepEqual(calls.filter(name => name === 'wallet.payInvoice').length, 2, 'the lock, then the payout')
  assert.deepEqual(calls.filter(name => name === 'wallet.createInvoicePublic').length, 1, 'the lock for the next attempt')
  assert.ok(calls.length <= 19, calls.join(', '))
})
