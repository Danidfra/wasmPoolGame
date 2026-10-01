// Guest-side wrapper over the LNbits host functions declared in
// wasm/lnbits-extension.wit. jco turns each WIT interface into a JS module
// ('lnbits:extension/host', ...); kebab-case WIT names become camelCase here.
// index.js only ever talks to the five objects exported below, which is what
// lets the tests swap in a fake host.
import {
  createInvoicePublic,
  listUserWallets,
  now,
  payInvoice,
  payLnurl,
  randomId,
  storageDelete,
  storageGet,
  storageGetPaginated,
  storageSet,
  websocketPublish
} from 'lnbits:extension/host'
import {
  decodeInvoice,
  randomSecretAndHash,
  validateInvoice,
  verifyPreimage
} from 'lnbits:extension/utils-lightning'

const extraPairs = extra => Object.entries(extra || {}).map(([key, value]) => [key, String(value)])

export const storage = {
  get(table, id) {
    const {dataJson} = storageGet({table, id})
    return dataJson ? JSON.parse(dataJson) : null
  },

  set(table, row) {
    storageSet({table, dataJson: JSON.stringify(row)})
    return row
  },

  delete(table, id) {
    storageDelete({table, id})
  },

  find(table, {filters = {}, sortBy = '', descending = false, limit = 25, offset = 0} = {}) {
    const {rowsJson, total} = storageGetPaginated({
      table,
      filtersJson: JSON.stringify(filters),
      search: '',
      searchFields: [],
      sortBy,
      descending,
      limit,
      offset
    })
    return {rows: JSON.parse(rowsJson || '[]'), total: Number(total || 0)}
  }
}

export const wallet = {
  listUserWallets() {
    return listUserWallets().wallets || []
  },

  createInvoicePublic({sourceId, amount, memo = '', extra = {}}) {
    return createInvoicePublic({
      sourceId,
      amount: Number(amount),
      currency: 'sat',
      memo,
      extra: extraPairs(extra)
    })
  },

  // Returns {ok, error, status, pending, success, paymentHash, ...}. LNbits
  // core refuses to pay the same BOLT11 twice from one wallet, which is the
  // only at-most-once guarantee the settlement code relies on.
  payInvoice({walletId, paymentRequest, maxSat, description = '', extra = {}}) {
    return payInvoice({
      walletId,
      paymentRequest,
      maxSat: BigInt(maxSat),
      description,
      extra: extraPairs(extra)
    })
  },

  // Resolves a Lightning address / LNURL-pay to a BOLT11 without paying it.
  fetchLnurlInvoice({walletId, lnurl, amount, description = ''}) {
    return payLnurl({
      walletId,
      lnurl,
      amount: Number(amount),
      currency: 'sat',
      comment: undefined,
      description,
      maxSat: BigInt(amount),
      extra: [],
      fetchOnly: true
    })
  }
}

export const websocket = {
  publish(itemId, data) {
    return websocketPublish({itemId, dataJson: JSON.stringify(data || {})})
  }
}

export const lightning = {
  validateInvoice(bolt11) {
    return validateInvoice({bolt11})
  },

  decodeInvoice(bolt11) {
    const decoded = decodeInvoice({bolt11})
    return {
      paymentHash: decoded.paymentHash || '',
      amountMsat: Number(decoded.amountMsat || 0),
      expiresAt: Number(decoded.expiresAt || 0)
    }
  },

  verifyPreimage(preimage, paymentHash) {
    return verifyPreimage({preimage, paymentHash}).valid === true
  },

  randomSecretAndHash() {
    return randomSecretAndHash({length: 32})
  }
}

export const system = {
  id(prefix) {
    return randomId({prefix}).id
  },

  now() {
    return Math.trunc(Number(now().timestamp))
  }
}
