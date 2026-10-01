import assert from 'node:assert/strict'
import {test} from 'node:test'
import '../../static/pool-engine.js'
import '../../static/pool-view.js'
import '../../static/pool-claim.js'
import '../../static/pool-fx.js'

const E = globalThis.PoolEngine
const V = globalThis.PoolView
const C = globalThis.PoolClaim
const PoolFx = globalThis.PoolFx

// A match view as the backend reports it, and a table to go with it.
function view(overrides = {}) {
  return {
    status: 'active',
    seats: [{seat: 1, name: 'Ana', paid: true}, {seat: 2, name: 'Bo', paid: true}],
    turn: 1,
    winner: 0,
    note: '',
    settlement: {seat: 0, amount: 0, reason: '', status: ''},
    you: {seat: 1, status: 'seated'},
    ...overrides
  }
}

function tableAfter(state, {first = null, potted = []}) {
  const balls = state.balls.map((at, id) => ({id, x: at ? at[0] : 0, y: at ? at[1] : 0, vx: 0, vy: 0, on: !!at && !potted.includes(id)}))
  return E.finishShot(state, {balls, first, potted, done: true})
}

const texts = events => events.map(event => event.text)

// ── The effects layer cannot change the game ────────────────────────────────

test('watching a shot with the effects layer attached does not change its result', () => {
  let seen = 0
  for (const [seed, shot] of [
    ['m_fx_1', {dx: -1, dy: 0.01, power: 100, place: null}],
    ['m_fx_2', {dx: -0.97, dy: -0.24, power: 64, place: null}],
    ['m_fx_3', {dx: 0.3, dy: 0.95, power: 88, place: null}]
  ]) {
    const state = E.initialState(seed)
    const plain = JSON.stringify(E.runShot(state, shot))

    const fx = new PoolFx()
    const sim = E.startShot(state, shot)
    fx.shotStarted(sim, 0)
    let frame = 0
    while (!sim.done) {
      E.stepShot(sim)
      fx.afterStep(sim, frame)
      // What the page does every frame: read positions, track rotation.
      if (frame % 4 === 0) fx.orient(sim.balls.filter(ball => ball.on).map(ball => ({id: ball.id, x: ball.x, y: ball.y})), frame % 8 === 0)
      frame += 1
    }
    assert.equal(JSON.stringify(E.finishShot(state, sim)), plain)
    seen += fx.rings.length + fx.sinks.length
  }
  assert.ok(seen > 8, 'the watcher was really watching: it recorded impacts')
})

test('the effects layer sees the impacts and pots the engine counted', () => {
  // Cue ball, object ball and corner pocket in one line.
  const state = E.initialState('layout')
  state.balls = state.balls.map((_, n) => (n === 0 ? [300, 300] : n === 5 ? [150, 150] : n === 8 ? [900, 250] : null))
  state.breaking = false
  state.groups = 1
  const fx = new PoolFx()
  const sim = E.startShot(state, {dx: -1, dy: -1, power: 60, place: null})
  fx.shotStarted(sim, 0)
  let rings = 0
  while (!sim.done) {
    E.stepShot(sim)
    const before = fx.rings.length
    fx.afterStep(sim, 0)
    rings += fx.rings.length - before
  }
  assert.equal(sim.hits, 1)
  assert.equal(rings, 1, 'one flash for the one collision')
  assert.deepEqual(fx.sinks.map(sink => [sink.id, sink.px, sink.py]), [[5, 0, 0]], 'the 5 sinks into the corner it went down')
  assert.deepEqual([fx.strike.x, fx.strike.y], [300, 300], 'the cue strikes from where the cue ball stood')
})

test('rolling keeps a ball a rigid sphere and turns it the way it travels', () => {
  let m = [1, 0, 0, 0, 1, 0, 0, 0, 1]
  // A quarter turn to the right brings the top of the ball to its right edge.
  m = V.roll(m, (Math.PI / 2) * E.BALL_RADIUS, 0, E.BALL_RADIUS)
  const top = [m[2], m[5], m[8]]
  assert.ok(Math.abs(top[0] - 1) < 1e-12 && Math.abs(top[1]) < 1e-12 && Math.abs(top[2]) < 1e-12)
  // After a long wander the matrix is still a rotation.
  for (let i = 0; i < 5000; i += 1) m = V.roll(m, Math.sin(i) * 9, Math.cos(i * 1.7) * 9, E.BALL_RADIUS)
  for (const [a, b] of [[0, 0], [1, 1], [2, 2], [0, 1], [0, 2], [1, 2]]) {
    const dot = m[a] * m[b] + m[3 + a] * m[3 + b] + m[6 + a] * m[6 + b]
    assert.ok(Math.abs(dot - (a === b ? 1 : 0)) < 1e-9)
  }
  assert.deepEqual(V.roll(m, 0, 0, E.BALL_RADIUS), m, 'a ball that has not moved has not turned')
})

test('balls do not roll when the table jumps to a new agreed state', () => {
  const fx = new PoolFx()
  const [first] = fx.orient([{id: 3, x: 100, y: 100}])
  const resting = first.m.slice()
  fx.settle()
  assert.deepEqual(fx.orient([{id: 3, x: 700, y: 300}])[0].m, resting, 'a jump is not a roll')
  assert.notDeepEqual(fx.orient([{id: 3, x: 720, y: 300}])[0].m, resting, 'movement after it is')
})

// ── Words and numbers ───────────────────────────────────────────────────────

test('amounts and stake presets', () => {
  assert.equal(V.sats(2000), '2,000')
  assert.equal(V.sats(1234567), '1,234,567')
  assert.equal(V.sats(undefined), '0')
  assert.deepEqual(V.stakePresets(100, 5000), [100, 250, 1000, 2500, 5000], 'spread across the range, both ends included')
  assert.deepEqual(V.stakePresets(100, 1000000), [100, 1000, 10000, 100000, 1000000])
  assert.deepEqual(V.stakePresets(123, 400), [123, 250])
  assert.deepEqual(V.stakePresets(7, 9), [7])
  for (const [min, max] of [[1, 1000000], [100, 100], [300, 301]]) {
    const picks = V.stakePresets(min, max)
    assert.ok(picks.length >= 1 && picks.length <= 5)
    assert.ok(picks.every(value => value >= min && value <= max))
  }
  assert.equal(V.initial('  ana'), 'A')
  assert.equal(V.initial(''), '?')
})

test('a player\'s remaining balls follow the table', () => {
  const state = E.initialState('m_groups')
  assert.deepEqual(V.groupBalls(state, 1), [], 'nothing to show while the table is open')
  const solids = tableAfter({...state, breaking: false}, {first: 2, potted: [2]})
  assert.equal(V.groupKind(solids, 1), V.SOLIDS)
  assert.equal(V.groupKind(solids, 2), V.STRIPES)
  assert.deepEqual(V.groupBalls(solids, 1).filter(ball => ball.down).map(ball => ball.number), [2])
  assert.deepEqual(V.groupBalls(solids, 2).map(ball => ball.number), [9, 10, 11, 12, 13, 14, 15])
  assert.equal(V.groupKind(solids, 1), E.groupOfSeat(solids, 1), 'the page and the engine agree on who has which group')
})

// ── Announcements ───────────────────────────────────────────────────────────

test('nothing is announced on first load', () => {
  const state = E.initialState('m_events')
  assert.deepEqual(V.events(null, V.snapshot(view(), state)), [])
})

test('joining, paying and starting are announced once', () => {
  const waiting = view({status: 'open', seats: [{seat: 1, name: '', paid: false}, {seat: 2, name: '', paid: false}], you: {seat: 0, status: 'pending'}})
  const paid = view({status: 'open', seats: [{seat: 1, name: 'Ana', paid: true}, {seat: 2, name: '', paid: false}]})
  const started = view()
  const a = V.snapshot(waiting, null)
  const b = V.snapshot(paid, null)
  const c = V.snapshot(started, E.initialState('m_events'))
  assert.deepEqual(texts(V.events(a, b)), ['Payment received. Your seat is confirmed.'])
  const start = V.events(b, c)
  assert.deepEqual(texts(start), ['Bo joined the table.', 'Game on'])
  assert.equal(start[1].sub, 'You break.')
  assert.deepEqual(V.events(c, c), [], 'the same state twice says nothing')
})

test('a shot is described by what it did', () => {
  const state = {...E.initialState('m_events'), breaking: false}
  const before = V.snapshot(view(), state)
  const say = (shot, viewAfter = view()) => V.events(before, V.snapshot(viewAfter, tableAfter(state, shot)))

  const pot = say({first: 2, potted: [2, 4]})
  assert.deepEqual(texts(pot), ['You potted the 2 and 4', 'You are solids'])
  assert.equal(pot[0].tone, 'good')
  assert.equal(pot[1].sub, 'Bo is stripes.')

  const foul = say({first: 1, potted: [0]})
  assert.deepEqual(texts(foul), ['Foul'])
  assert.equal(foul[0].sub, 'Cue ball potted. Ball in hand for Bo.')
  assert.equal(foul[0].tone, 'bad')
  assert.equal(say({first: null})[0].sub, 'No ball hit. Ball in hand for Bo.')

  assert.deepEqual(texts(say({first: 3})), ["Bo's turn"])

  // The same shots seen from the other chair.
  const asBo = view({you: {seat: 2, status: 'seated'}})
  const seen = V.events(V.snapshot(asBo, state), V.snapshot(asBo, tableAfter(state, {first: 2, potted: [2]})))
  assert.deepEqual(texts(seen), ['Ana potted the 2', 'You are stripes'])
  const miss = V.events(V.snapshot(asBo, state), V.snapshot(asBo, tableAfter(state, {first: 3})))
  assert.deepEqual(miss.map(event => [event.text, event.sound]), [['Your turn', 'turn']])
  const theirFoul = V.events(V.snapshot(asBo, state), V.snapshot(asBo, tableAfter(state, {first: 1, potted: [0]})))
  assert.equal(theirFoul[0].sub, 'Cue ball potted. Ball in hand for you.')
})

test('the 8-ball moments are called out', () => {
  const state = E.initialState('m_events')
  const before = V.snapshot(view(), state)
  const respot = V.events(before, V.snapshot(view(), tableAfter(state, {first: 1, potted: [8]})))
  assert.ok(texts(respot).includes('8-ball back on the spot'))

  // One solid left for seat 1; potting it puts them on the 8.
  const late = {...state, breaking: false, groups: 1, balls: state.balls.map((at, n) => (n >= 2 && n <= 7 ? null : at))}
  const after = tableAfter(late, {first: 1, potted: [1]})
  assert.deepEqual(texts(V.events(V.snapshot(view(), late), V.snapshot(view(), after))), ['You potted the 1', 'You are on the 8-ball'])
})

test('the end of a match is announced to each side in its own words', () => {
  const state = E.initialState('m_events')
  const before = V.snapshot(view(), state)
  const won = view({status: 'finished', winner: 1, settlement: {seat: 1, amount: 2000, reason: 'prize', status: ''}})
  const win = V.events(before, V.snapshot(won, state))
  assert.deepEqual(win.map(event => [event.text, event.tone, event.sound]), [['You win!', 'win', 'win']])

  const lost = view({status: 'finished', winner: 2, note: 'Ana conceded.'})
  const lose = V.events(before, V.snapshot(lost, state))
  assert.deepEqual(lose.map(event => [event.text, event.sub, event.tone]), [['Bo wins', 'Ana conceded.', 'lose']])

  const watching = view({you: null})
  const seen = V.events(V.snapshot(watching, state), V.snapshot({...won, you: null}, state))
  assert.deepEqual(seen.map(event => [event.text, event.tone, event.sound]), [['Ana wins', 'info', '']])

  const paid = view({status: 'finished', winner: 1, settlement: {seat: 1, amount: 2000, reason: 'prize', status: 'paid'}})
  assert.deepEqual(texts(V.events(V.snapshot(won, state), V.snapshot(paid, state))), ['2,000 sats sent to your wallet.'])
  assert.deepEqual(V.events(V.snapshot({...won, you: {seat: 2, status: 'seated'}}, state), V.snapshot({...paid, you: {seat: 2, status: 'seated'}}, state)), [], 'the loser is not told about the payout')

  const frozen = V.events(before, V.snapshot(view({status: 'disputed'}), state))
  assert.equal(frozen[0].tone, 'bad')
})

test('the result screen offers the right thing for every payout state', () => {
  const view = (status, detail = '') => ({status: 'finished', note: 'Bo conceded.', updatedAt: 1000, serverTime: 1001, settlement: {seat: 1, amount: 9, reason: 'prize', status, detail}})
  const offered = (status, detail) => V.payout(view(status, detail), true, 0)

  assert.deepEqual([offered('').form, offered('').button, offered('').line], ['destination', 'Claim 9 sats', ''])
  assert.equal(offered('paying').form, '')
  assert.equal(offered('pending').line, 'Sending 9 sats')
  assert.deepEqual([offered('paid').form, offered('paid').tone], ['', 'paid'])
  assert.equal(offered('manual').form, '')

  // Nothing was sent, and the invoice on record is tried again: a button,
  // no field for another destination, and the reason.
  const short = offered('unsent', 'You must reserve at least (2  sat) to cover potential routing fees.')
  assert.deepEqual([short.form, short.button], ['retry', 'Try again'])
  assert.match(short.line, /Nothing was sent.*hall operator to top up.*then try again/)
  assert.match(offered('unsent', 'payment exceeds max amount').line, /Nothing was sent \(payment exceeds max amount\)\. Your 9 sats are safe\. Try again/)
  assert.equal(offered('refused', 'Insufficient balance.').form, 'retry', 'the name an earlier backend used for the same state')

  // A payment may exist: only the invoice the backend already has is retried.
  assert.deepEqual([offered('failed', 'Payment failed: no route').form, offered('failed').button], ['retry', 'Try the payment again'])
  assert.match(offered('failed', 'Payment failed: no route').line, /did not go through \(Payment failed: no route\)/)
  assert.deepEqual([offered('unconfirmed').form, offered('unconfirmed').button], ['retry', 'Check the payment again'])
  assert.match(offered('unconfirmed', 'The payment was started and its result was never recorded.').line, /may have arrived.*check again in a moment/)
  // From a wallet the payout emptied, checking again cannot help, and the page says so.
  assert.match(offered('unconfirmed', 'x. Last check: Insufficient balance.').line, /may have arrived.*until the hall wallet is topped up.*will not help yet/)
  assert.match(offered('unconfirmed', 'x. Last check: You must reserve at least (2  sat) to cover potential routing fees.').line, /topped up/)

  // LNbits will never send that invoice: now, and only now, another one can be named.
  const released = offered('released', 'Payment is failed node, retrying is not possible.')
  assert.deepEqual([released.form, released.button], ['destination', 'Claim 9 sats'])
  assert.match(released.line, /will not be tried again.*new invoice or another wallet/)

  // Everyone else only hears how the prize is doing.
  assert.equal(V.payout(view('unsent', 'x'), false, 0).line, '')
  assert.equal(V.payout(view('paid'), false, 0).line, 'Prize paid out')
  assert.equal(V.payout({...view('paid'), status: 'cancelled'}, false, 0).line, '')
})

test('a page that gets no more answers stops saying "sending"', () => {
  // The last thing the backend said: the payment was started a second ago.
  const view = {status: 'finished', note: '', updatedAt: 5000, serverTime: 5001, settlement: {seat: 1, amount: 10, reason: 'prize', status: 'paying'}}
  assert.equal(V.payout(view, true, 0).line, 'Sending 10 sats')
  assert.equal(V.payout(view, true, 10).line, 'Sending 10 sats')
  // Twenty seconds on, with nothing new from the backend, the page offers to check.
  const late = V.payout(view, true, 25)
  assert.deepEqual([late.form, late.button, late.tone], ['retry', 'Check the payment again', 'bad'])
  assert.match(late.line, /could not be confirmed/)
  // The same when the view was already old on arrival.
  assert.equal(V.payout({...view, serverTime: 5030}, true, 0).form, 'retry')
  // A payment LNbits reports in flight is given longer, not for ever.
  const pending = {...view, settlement: {...view.settlement, status: 'pending'}}
  assert.equal(V.payout(pending, true, 60).line, 'Sending 10 sats')
  assert.equal(V.payout(pending, true, 200).button, 'Check the payment again')
  // Whoever is watching is not told it is on its way either.
  assert.equal(V.payout(view, false, 25).line, '')
})

// ── The requests that make up a claim ───────────────────────────────────────

test('a claim to a Lightning address is three requests: resolve, record, pay', async () => {
  const sent = []
  const answers = [
    {match: {id: 'm', n: 1}, resolved: 'lnbc-invoice'},
    {match: {id: 'm', n: 2}, settling: true, bound: true},
    {match: {id: 'm', n: 3}}
  ]
  const outcome = await C.run(destination => {
    sent.push(destination)
    return Promise.resolve(answers[sent.length - 1])
  }, 'ana@wallet.example')
  assert.deepEqual(sent, ['ana@wallet.example', 'lnbc-invoice', ''])
  assert.deepEqual(outcome, {view: {id: 'm', n: 3}, state: 'done', error: null})
})

test('a request that is never answered ends the claim without calling it a failure', async () => {
  const sent = []
  const started = Date.now()
  const outcome = await C.run(destination => {
    sent.push(destination)
    // Recording answers; the paying request is the one LNbits cuts off.
    return sent.length === 1 ? Promise.resolve({match: {id: 'm', settlement: {status: 'paying'}}, settling: true, bound: true}) : new Promise(() => {})
  }, 'lnbc-invoice', {timeoutMs: 40})
  assert.equal(outcome.state, 'timeout')
  assert.ok(Date.now() - started < 1000, 'it does not wait for ever')
  assert.deepEqual(sent, ['lnbc-invoice', ''], 'and does not send anything again by itself')
  assert.equal(outcome.view.settlement.status, 'paying', 'the page keeps the last thing it was told, and looks at the match again')
})

test('a refused request and "someone else is at it" are told apart', async () => {
  const refused = await C.run(() => Promise.reject(new Error('Enter a Lightning address.')), '')
  assert.equal(refused.state, 'error')
  assert.equal(refused.error.message, 'Enter a Lightning address.')
  const settling = await C.run(() => Promise.resolve({match: {id: 'm'}, settling: true}), 'lnbc-invoice')
  assert.deepEqual(settling, {view: {id: 'm'}, state: 'settling', error: null})
  // A backend that kept answering "next step" is not followed for ever.
  let calls = 0
  const endless = await C.run(() => Promise.resolve({match: {id: 'm'}, bound: true, calls: (calls += 1)}), 'lnbc-invoice')
  assert.equal(endless.state, 'settling')
  assert.equal(calls, 4)
})

test('the page asks again by itself a few times, then leaves it to the player', () => {
  const delays = [0, 1, 2, 3, 4, 5].map(tries => C.nextCheck(tries))
  assert.deepEqual(delays.slice(4), [null, null])
  assert.ok(delays.slice(0, 4).every(delay => delay >= 3000))
  assert.ok(delays.slice(0, 4).reduce((sum, delay) => sum + delay, 0) < 120000)
})

test('a payout remark left in the note by an earlier version is not shown as the match note', () => {
  assert.equal(V.matchNote({note: 'Bo conceded.'}), 'Bo conceded.')
  assert.equal(V.matchNote({note: 'Payout failed: Payment failed: no route'}), '')
  assert.equal(V.matchNote({}), '')
})

// ── Notes on the owner page ─────────────────────────────────────────────────

test('a hall with no fee, or with very small stakes, gets a note and is not refused', async () => {
  await import('../../static/hall-advice.js')
  const H = globalThis.HallAdvice
  const ids = hall => H.notes(hall).map(note => note.id)

  assert.deepEqual(ids({feePercent: 10, minStake: 100}), [])
  assert.deepEqual(ids({feePercent: 1, minStake: 50}), [], 'the recommended smallest stake itself needs no note')

  const free = H.notes({feePercent: 0, minStake: 100})
  assert.deepEqual(free.map(note => note.id), ['no-fee'])
  assert.match(free[0].text, /0% hall fee.*whole pot is paid to the winner.*extra sats.*routing fees.*topped up/)

  const small = H.notes({feePercent: 10, minStake: 5})
  assert.deepEqual(small.map(note => note.id), ['small-stakes'])
  assert.match(small[0].text, /below 50 sats.*testing.*recommendation, not a Lightning rule/)
  assert.deepEqual(ids({feePercent: 0, minStake: 1}), ['no-fee', 'small-stakes'])

  // Nothing typed yet, or nonsense, is not commented on.
  assert.deepEqual(ids({feePercent: NaN, minStake: NaN}), [])
  assert.deepEqual(ids({feePercent: NaN, minStake: 0}), [])
  assert.equal(H.RECOMMENDED_MIN_STAKE, 50)
})
