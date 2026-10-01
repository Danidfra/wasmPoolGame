// LN Pool hall advice: what the owner page says about a hall's fee and stakes.
// Pure, so it can be tested. These are notes, never errors: every value the
// backend accepts can be saved.
;(function (root) {
  'use strict'

  // A sensible smallest stake for normal use. It is advice about running
  // costs, not a Lightning rule: routing fees vary, and LNbits holds back a
  // reserve for them (2 sats, or 1% if that is more, by default) that weighs
  // more the smaller the pot is.
  const RECOMMENDED_MIN_STAKE = 50

  // The notes for the values now in the form, most important first.
  function notes(hall) {
    const fee = Number(hall.feePercent)
    const minStake = Number(hall.minStake)
    const list = []
    if (fee === 0) {
      list.push({
        id: 'no-fee',
        text: 'With a 0% hall fee the whole pot is paid to the winner. Keep extra sats in this wallet for Lightning routing fees, or payouts will fail until it is topped up.'
      })
    }
    if (Number.isFinite(minStake) && minStake > 0 && minStake < RECOMMENDED_MIN_STAKE) {
      list.push({
        id: 'small-stakes',
        text: 'Stakes below ' + RECOMMENDED_MIN_STAKE + ' sats are fine for testing. In normal use, routing fees and their reserve are large next to such a small pot, so the wallet needs more spare sats for each payout. ' +
          RECOMMENDED_MIN_STAKE + ' sats per player is a sensible minimum; it is a recommendation, not a Lightning rule.'
      })
    }
    return list
  }

  root.HallAdvice = Object.freeze({RECOMMENDED_MIN_STAKE, notes})
})(typeof globalThis !== 'undefined' ? globalThis : this)
