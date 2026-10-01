// A fake LNbits host for the guest code in src/index.js, so the backend can be
// tested without building or running WASM.
//
// The fake wallet copies the one behaviour of LNbits core the settlement code
// depends on: a given invoice can be paid at most once, and a second attempt
// fails with "already paid" (lnbits/core/services/payments.py, exercised by
// core's own test_pay_twice_fast_same_invoice).
import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'

const source = (await readFile(new URL('../src/index.js', import.meta.url), 'utf8'))
  .replace(/^import \{[^}]+\} from '\.\/lnbits-sdk\.js'\n\n/, '')
  .replace(/^export function /gm, 'function ')
const exportNames = [...source.matchAll(/^function ([A-Za-z]+Lnpool[A-Za-z]*)\(/gm)].map(match => match[1])
const build = new Function(
  'lightning',
  'storage',
  'system',
  'wallet',
  'websocket',
  `${source}\nreturn {${exportNames.join(', ')}}`
)

const hex64 = number => createHash('sha256').update('lnpool-test-' + number).digest('hex')

export function createHost() {
  const tables = new Map()
  const invoices = new Map()
  let counter = 0

  const host = {
    now: 1_800_000_000,
    balance: 0,
    ownerWallets: [{id: 'wallet_hall', name: 'Hall wallet'}],
    payments: [], // every successful outgoing payment: {bolt11, amount, kind}
    published: [],
    writes: [], // every storage write, in order
    hostCalls: [], // every host function the guest called, in order
    beforePay: null, // (bolt11) => void, runs while a payment is "in flight"
    failPayments: null, // (invoice) => error string | null
    lnurl: new Map() // address -> amount => bolt11
  }

  const rows = table => {
    if (!tables.has(table)) tables.set(table, new Map())
    return tables.get(table)
  }

  host.row = (table, id) => {
    const row = rows(table).get(id)
    return row ? structuredClone(row) : null
  }
  host.rows = table => [...rows(table).values()].map(row => structuredClone(row))
  // Write a row behind the guest's back, the way a racing invocation would.
  host.rawSet = (table, row) => {
    rows(table).set(row.id, structuredClone(row))
  }

  // An invoice created by a player's own wallet, to be paid a prize into.
  host.externalInvoice = (amount, {expiresIn = 3600} = {}) => {
    counter += 1
    const paymentHash = hex64('external-' + counter)
    const bolt11 = 'lnbc' + amount + 'n1external' + counter
    invoices.set(bolt11, {bolt11, amount, paymentHash, internal: false, paid: false, pending: false, expiresAt: host.now + expiresIn})
    return bolt11
  }

  host.invoice = bolt11 => invoices.get(bolt11)

  const storage = {
    get(table, id) {
      return host.row(table, id)
    },
    set(table, row) {
      if (!row.id) throw new Error('row needs an id')
      rows(table).set(row.id, structuredClone(row))
      host.writes.push({table, id: row.id})
      return row
    },
    find(table, {filters = {}, sortBy = '', descending = false, limit = 25, offset = 0} = {}) {
      let found = host.rows(table).filter(row => Object.entries(filters).every(([key, value]) => row[key] === value))
      if (sortBy) found.sort((a, b) => (a[sortBy] < b[sortBy] ? -1 : a[sortBy] > b[sortBy] ? 1 : 0) * (descending ? -1 : 1))
      return {rows: found.slice(offset, offset + limit), total: found.length}
    }
  }

  const wallet = {
    listUserWallets() {
      return host.ownerWallets
    },
    createInvoicePublic({sourceId, amount, memo, extra}) {
      if (!host.row('lnpool_matches', sourceId)) throw new Error('Public invoice source was not found.')
      counter += 1
      const paymentHash = hex64('internal-' + counter)
      const bolt11 = 'lnbc' + amount + 'n1internal' + counter
      invoices.set(bolt11, {bolt11, amount, paymentHash, internal: true, paid: false, pending: false, expiresAt: host.now + 3600, sourceId, memo, extra})
      return {paymentHash, paymentRequest: bolt11, checkingId: paymentHash}
    },
    payInvoice({walletId, paymentRequest, maxSat, extra}) {
      const invoice = invoices.get(paymentRequest)
      if (!invoice) return {ok: false, error: 'Bolt11 decoding failed.'}
      if (invoice.amount > maxSat) return {ok: false, error: 'Invoice amount ' + invoice.amount + ' sats is too high.'}
      if (invoice.paid) return {ok: false, error: invoice.internal ? 'Internal invoice already paid.' : 'Payment already paid.'}
      if (invoice.pending) return {ok: false, error: 'Payment is still pending.'}
      if (invoice.expiresAt <= host.now) return {ok: false, error: 'Invoice has expired.'}
      if (host.balance < invoice.amount) return {ok: false, error: 'Insufficient balance.'}
      const refusal = host.failPayments ? host.failPayments(invoice) : null
      if (refusal) return {ok: false, error: refusal}
      // Mark it first: from here on nobody else can pay this invoice, exactly
      // like the payment row LNbits inserts under the wallet lock.
      invoice.paid = true
      if (host.beforePay) host.beforePay(paymentRequest)
      if (!invoice.internal) host.balance -= invoice.amount
      host.payments.push({bolt11: paymentRequest, amount: invoice.amount, kind: extra.lnpool_kind, walletId})
      if (invoice.leavePending) {
        return {ok: true, success: false, pending: true, paymentHash: invoice.paymentHash}
      }
      return {ok: true, success: true, pending: false, paymentHash: invoice.paymentHash}
    },
    fetchLnurlInvoice({lnurl, amount}) {
      const make = host.lnurl.get(lnurl)
      if (!make) return {ok: false, error: 'Lightning address not found'}
      return {ok: true, paymentRequest: make(amount)}
    }
  }

  const lightning = {
    validateInvoice(bolt11) {
      return {valid: invoices.has(bolt11)}
    },
    decodeInvoice(bolt11) {
      const invoice = invoices.get(bolt11)
      return {paymentHash: invoice.paymentHash, amountMsat: invoice.amount * 1000, expiresAt: invoice.expiresAt}
    },
    verifyPreimage(preimage, paymentHash) {
      return createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex') === paymentHash
    },
    randomSecretAndHash() {
      counter += 1
      const secret = hex64('secret-' + counter)
      return {secret, hash: createHash('sha256').update(Buffer.from(secret, 'hex')).digest('hex')}
    }
  }

  const system = {
    id(prefix) {
      counter += 1
      return prefix + '_' + String(counter).padStart(6, '0')
    },
    now() {
      return host.now
    }
  }

  const websocket = {
    publish(itemId, data) {
      host.published.push({itemId, data})
      return {sent: true}
    }
  }

  // Each host call costs the real runtime fuel, so the tests can count them.
  const counted = (prefix, api) =>
    Object.fromEntries(
      Object.entries(api).map(([name, fn]) => [
        name,
        (...args) => {
          host.hostCalls.push(prefix + '.' + name)
          return fn(...args)
        }
      ])
    )
  const guest = build(
    counted('lightning', lightning),
    counted('storage', storage),
    counted('system', system),
    counted('wallet', wallet),
    counted('websocket', websocket)
  )
  host.call = (name, payload = {}) => {
    if (!guest[name]) throw new Error('no export ' + name)
    return JSON.parse(guest[name](JSON.stringify(payload)))
  }
  // Like call(), but returns data and throws on {ok: false}.
  host.ok = (name, payload) => {
    const result = host.call(name, payload)
    if (result.ok !== true) throw new Error(name + ': ' + result.error)
    return result.data
  }

  // Settle a buy-in invoice the way LNbits does: money arrives, then the
  // invoice-paid event is delivered with the payload built in
  // lnbits/core/wasm_ext/wasm/events.py.
  host.payBuyIn = (bolt11, {amountMsat} = {}) => {
    const invoice = invoices.get(bolt11)
    if (!invoice.paid) host.balance += invoice.amount
    invoice.paid = true
    return host.call('recordLnpoolPayment', host.paidEvent(bolt11, amountMsat))
  }

  host.paidEvent = (bolt11, amountMsat) => {
    const invoice = invoices.get(bolt11)
    return {
      checkingId: invoice.paymentHash,
      paymentHash: invoice.paymentHash,
      walletId: 'wallet_hall',
      amount: amountMsat ?? invoice.amount * 1000,
      fee: 0,
      status: 'success',
      pending: false,
      tag: 'lnpool',
      extension: 'lnpool',
      extra: {tag: 'lnpool', source_id: invoice.sourceId, extra_lnpool: invoice.extra},
      payment: {}
    }
  }

  return host
}

// A hall that is open, plus helpers to get a match to a given point.
export function openHall(host, settings = {}) {
  return host.ok('saveLnpoolHall', {
    enabled: true,
    walletId: 'wallet_hall',
    walletName: 'Hall wallet',
    minStake: 100,
    maxStake: 10000,
    feePercent: 0,
    ...settings
  }).hall
}

// Two paid players at a table. Returns their credentials keyed by seat.
export function startMatch(host, {stake = 1000, hall = null} = {}) {
  const theHall = hall || openHall(host)
  const created = host.ok('createLnpoolMatch', {hallId: theHall.id, name: 'Ana', stake})
  const matchId = created.match.id
  host.payBuyIn(created.paymentRequest)
  const joined = host.ok('joinLnpoolMatch', {matchId, name: 'Bo'})
  host.payBuyIn(joined.paymentRequest)
  const seat = credentials => ({matchId, playerId: credentials.playerId, token: credentials.token})
  return {matchId, hall: theHall, invoices: [created.paymentRequest, joined.paymentRequest], 1: seat(created), 2: seat(joined)}
}

// Play one turn through the backend: the shooter records a shot, then both
// players report `result`.
export function playTurn(host, match, result) {
  const view = host.ok('getPublicLnpoolMatch', {matchId: match.matchId}).match
  const shooter = match[view.turn]
  host.ok('shootLnpoolMatch', {...shooter, seq: view.seq, shot: {dx: -1, dy: 0, power: 50, place: null}})
  host.ok('reportLnpoolResult', {...match[1], seq: view.seq, result})
  return host.ok('reportLnpoolResult', {...match[2], seq: view.seq, result}).match
}
