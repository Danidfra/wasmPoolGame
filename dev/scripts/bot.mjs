// A headless opponent, for testing a match on your own.
//
//   node scripts/bot.mjs http://localhost:9000/ext/lnpool/matches/<match_id> [name]
//
// It joins the match, prints its buy-in invoice for you to pay, then plays its
// turns through the same public API and the same engine the browser uses: it
// records a shot, simulates it, and reports the table it got. If it wins it
// claims the prize only when LNPOOL_BOT_CLAIM is set to a Lightning address or
// an invoice for the exact prize.
import '../../static/pool-engine.js'

const E = globalThis.PoolEngine
const [link, name = 'Bot'] = process.argv.slice(2)
const parsed = link ? link.match(/^(https?:\/\/[^/]+)\/ext\/lnpool\/matches\/([^/?#]+)/) : null
if (!parsed) {
  console.error('usage: node scripts/bot.mjs <match link> [name]')
  process.exit(1)
}
const api = parsed[1] + '/api/v1/ext/lnpool/matches/' + parsed[2]
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function call(method, suffix, body) {
  const response = await fetch(api + suffix, {
    method,
    headers: body ? {'content-type': 'application/json'} : {},
    body: body ? JSON.stringify(body) : undefined
  })
  const result = await response.json()
  if (!response.ok || result.ok !== true) throw new Error(result.error || result.detail || 'HTTP ' + response.status)
  return result.data
}

const joined = await call('POST', '/join', {name})
const creds = {playerId: joined.playerId, token: joined.token}
console.log('Pay this invoice to seat ' + name + ' (' + joined.amount + ' sats):\n' + joined.paymentRequest + '\n')

let reported = -1
let announced = ''
for (;;) {
  let view
  try {
    view = (await call('POST', '/sync', creds)).match
  } catch (error) {
    console.error('sync failed: ' + error.message)
    await sleep(2000)
    continue
  }
  const seat = view.you.seat
  const line = view.status + (view.status === 'active' ? ', shot ' + (view.seq + 1) + ', seat ' + view.turn + ' to play' : '')
  if (line !== announced) console.log((seat ? '[seat ' + seat + '] ' : '[no seat yet] ') + line)
  announced = line

  if (view.you.status === 'unseated') {
    console.log('The seat was taken before this payment arrived. The hall operator has to refund it.')
    break
  }
  if (['finished', 'cancelled', 'disputed', 'resolved'].includes(view.status)) {
    if (view.status === 'finished') console.log(view.winner === seat ? name + ' won.' : name + ' lost.')
    if (view.status === 'finished' && view.winner === seat && process.env.LNPOOL_BOT_CLAIM) {
      const claimed = await call('POST', '/claim', {...creds, destination: process.env.LNPOOL_BOT_CLAIM})
      console.log('claim: ' + claimed.match.settlement.status)
    }
    break
  }

  if (view.status === 'active' && seat) {
    const table = view.game || E.initialState(view.id)
    if (!view.shot && view.turn === seat) {
      const shot = chooseShot(table, seat)
      await call('POST', '/shot', {...creds, seq: view.seq, shot})
      continue
    }
    if (view.shot && view.shot.seq === view.seq && reported !== view.seq) {
      const result = E.runShot(table, view.shot.shot)
      await call('POST', '/result', {...creds, seq: view.seq, result})
      reported = view.seq
      continue
    }
  }
  await sleep(1000)
}

// Not a clever player: it shoots straight at the nearest ball it is allowed to
// hit first, a little harder the further away it is.
function chooseShot(table, seat) {
  const cue = table.balls[0]
  const group = E.groupOfSeat(table, seat)
  const mine = group ? E.remaining(table, group) : []
  let targets = mine
  if (!targets.length) targets = group ? [8] : table.balls.map((at, number) => (at && number > 0 && number !== 8 ? number : 0)).filter(Boolean)
  if (table.breaking) targets = table.balls.map((at, number) => (at && number > 0 ? number : 0)).filter(Boolean)
  let best = null
  for (const number of targets) {
    const at = table.balls[number]
    if (!at) continue
    const distance = Math.hypot(at[0] - cue[0], at[1] - cue[1])
    if (!best || distance < best.distance) best = {dx: at[0] - cue[0], dy: at[1] - cue[1], distance}
  }
  if (!best) return {dx: -1, dy: 0, power: 50, place: null}
  const power = table.breaking ? 100 : Math.min(85, 30 + best.distance / 12)
  return {dx: best.dx / best.distance, dy: best.dy / best.distance, power, place: null}
}
