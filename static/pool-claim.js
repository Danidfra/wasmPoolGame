// LN Pool claim flow: the requests that make up one claim, with no DOM and no
// network of its own, so that it can be tested.
//
// A claim is up to three requests, because each has to fit inside the time
// LNbits allows one extension call:
//   1. a Lightning address is resolved to an invoice, which comes back here;
//   2. that invoice is recorded as the one the match pays;
//   3. it is paid.
// Any of them can go unanswered. With a slow funding source the paying
// request usually does: LNbits stops the call when its time is up, and the
// payment arrives all the same. No answer therefore says nothing about the
// payment, and the page must neither report a failure nor wait for ever: it
// looks at the match again and offers to check.
;(function (root) {
  'use strict'

  // LNbits gives up on a call after about seven seconds.
  const REQUEST_TIMEOUT_MS = 15000
  // When to ask again by itself while a payment is unsettled, after each
  // request. The backend leaves a payment alone for its first 15 seconds, so
  // the first look comes early (it costs nothing) and the next ones after
  // that. Then the page stops asking and leaves a button.
  const CHECK_DELAYS_MS = [3000, 14000, 20000, 40000]

  function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error('LNbits did not answer in time.')
        error.timedOut = true
        reject(error)
      }, ms)
      promise.then(
        value => {
          clearTimeout(timer)
          resolve(value)
        },
        error => {
          clearTimeout(timer)
          reject(error)
        }
      )
    })
  }

  // Runs one claim. `send(destination)` makes the request and resolves with
  // the backend's answer. Resolves, never rejects, with:
  //   view   the last match view received, or null
  //   state  'done'      the backend answered with where the payout stands
  //          'settling'  another request is at work; ask again shortly
  //          'timeout'   a request went unanswered
  //          'error'     a request was refused (see `error`)
  async function run(send, destination, options = {}) {
    const timeoutMs = options.timeoutMs || REQUEST_TIMEOUT_MS
    let next = destination
    let view = null
    for (let step = 0; step < 4; step += 1) {
      let data
      try {
        data = await withTimeout(Promise.resolve().then(() => send(next)), timeoutMs)
      } catch (error) {
        return {view, state: error.timedOut ? 'timeout' : 'error', error}
      }
      if (data && data.match) view = data.match
      if (data && data.resolved) next = data.resolved
      else if (data && data.bound) next = ''
      else return {view, state: data && data.settling ? 'settling' : 'done', error: null}
    }
    return {view, state: 'settling', error: null}
  }

  // Milliseconds until the next automatic look, or null when the page has
  // asked often enough and the player has to press the button.
  function nextCheck(tries) {
    return tries < CHECK_DELAYS_MS.length ? CHECK_DELAYS_MS[tries] : null
  }

  root.PoolClaim = Object.freeze({REQUEST_TIMEOUT_MS, run, nextCheck})
})(typeof globalThis !== 'undefined' ? globalThis : this)
