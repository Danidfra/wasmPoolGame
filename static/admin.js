// LN Pool hall owner page: hall settings, payout authorization, the match
// list, and the tools for the cases that need a person (unseated buy-ins,
// disputed or stuck matches).
;(function () {
  'use strict'

  const bridge = window.createLnbitsBridge('lnpool')
  const E = window.PoolEngine
  const $ = id => document.getElementById(id)
  const origin = new URL(window.location.href).origin
  // Rows per page of the match list. The backend accepts up to 100.
  const PAGE_SIZE = 8

  const app = {hall: null, wallets: [], page: 1, total: 0, detail: null, resolveArmed: false}

  init().catch(error => notice(error.message))

  async function init() {
    $('save').addEventListener('click', saveHall)
    $('authorize').addEventListener('click', () => authorize(true))
    $('copy-hall').addEventListener('click', () => copy($('hall-link').value))
    $('open-hall').addEventListener('click', () => goTo('/ext/lnpool/halls/' + encodeURIComponent(app.hall.id)))
    $('refresh').addEventListener('click', loadMatches)
    $('prev').addEventListener('click', () => turnPage(-1))
    $('next').addEventListener('click', () => turnPage(1))
    $('detail-close').addEventListener('click', () => showDetail(null))
    $('resolve').addEventListener('click', resolveMatch)
    $('open-match').addEventListener('click', () => goTo('/ext/lnpool/matches/' + encodeURIComponent(app.detail.match.id)))

    const [wallets, hall] = await Promise.all([bridge.api('GET', '/wallets'), bridge.api('GET', '/hall')])
    app.wallets = wallets.wallets || []
    renderHall(hall.hall)
    await loadMatches()
  }

  // ── Hall ──────────────────────────────────────────────────────────────────

  function renderHall(hall) {
    app.hall = hall
    const select = $('wallet')
    select.replaceChildren()
    for (const wallet of app.wallets) {
      const option = document.createElement('option')
      option.value = wallet.id
      option.textContent = wallet.name
      select.append(option)
    }
    if (hall.walletId) select.value = hall.walletId
    $('enabled').checked = hall.enabled
    $('min-stake').value = hall.minStake
    $('max-stake').value = hall.maxStake
    $('fee').value = hall.feePercent
    $('link-row').hidden = !hall.id
    $('link-help').textContent = hall.id
      ? 'Share this link. Players create matches there and send each match link to their opponent.'
      : 'Save the hall to get its link.'
    $('hall-link').value = hall.id ? origin + '/ext/lnpool/halls/' + encodeURIComponent(hall.id) : ''
  }

  async function saveHall() {
    const select = $('wallet')
    const chosen = app.wallets.find(wallet => wallet.id === select.value)
    try {
      const data = await bridge.api('PUT', '/hall', {
        enabled: $('enabled').checked,
        walletId: chosen ? chosen.id : '',
        walletName: chosen ? chosen.name : '',
        minStake: Number($('min-stake').value),
        maxStake: Number($('max-stake').value),
        feePercent: Number($('fee').value)
      })
      renderHall(data.hall)
      notice('Hall saved.', true)
      // Payouts need a background payment grant large enough for the biggest pot.
      if (data.hall.enabled) await authorize(false)
    } catch (error) {
      notice(error.message)
    }
  }

  async function authorize(forcePrompt) {
    if (!app.hall || !app.hall.walletId) {
      notice('Choose a wallet and save the hall first.')
      return
    }
    try {
      await bridge.requestBackgroundPayments(
        {walletId: app.hall.walletId, maxAmount: app.hall.maxStake * 2, destinationPolicy: 'external_allowed'},
        forcePrompt
      )
      if (forcePrompt) notice('Payouts authorized up to ' + app.hall.maxStake * 2 + ' sats.', true)
    } catch (error) {
      notice('Payouts are not authorized: ' + error.message + ' Winners cannot be paid automatically until they are.')
    }
  }

  // ── Matches ───────────────────────────────────────────────────────────────

  async function loadMatches() {
    let data
    try {
      data = await bridge.api('GET', '/matches?page=' + app.page + '&rowsPerPage=' + PAGE_SIZE)
    } catch (error) {
      notice(error.message)
      return
    }
    app.total = data.total
    const body = $('matches')
    body.replaceChildren()
    for (const match of data.matches) {
      const row = document.createElement('tr')
      if (needsAttention(match)) row.className = 'attention'
      row.append(
        cell((match.p1Name || 'nobody') + ' vs ' + (match.p2Name || 'nobody')),
        cell(match.stake + ' sats'),
        cell(statusLabel(match)),
        cell(payoutLabel(match)),
        cell(when(match.updatedAt))
      )
      const actions = document.createElement('td')
      const details = document.createElement('button')
      details.className = 'quiet'
      details.textContent = 'Details'
      details.addEventListener('click', () => openDetail(match.id))
      actions.append(details)
      row.append(actions)
      body.append(row)
    }
    $('no-matches').hidden = data.matches.length > 0
    $('prev').disabled = app.page <= 1
    $('next').disabled = app.page * PAGE_SIZE >= app.total

    const list = $('unseated')
    list.replaceChildren()
    for (const player of data.unseated) {
      const item = document.createElement('li')
      const label = document.createElement('span')
      label.textContent = player.name + ' paid ' + player.paidAmount + ' sats on ' + when(player.createdAt) + ' · payment ' + player.paymentHash
      const button = document.createElement('button')
      button.className = 'quiet'
      button.textContent = 'Copy hash'
      button.addEventListener('click', () => copy(player.paymentHash))
      item.append(label, button)
      list.append(item)
    }
    $('unseated-card').hidden = data.unseated.length === 0
  }

  function turnPage(step) {
    app.page = Math.max(1, app.page + step)
    loadMatches()
  }

  function needsAttention(match) {
    if (match.status === 'disputed') return true
    if (['failed', 'manual', 'unsent', 'released', 'unconfirmed'].includes(match.payoutStatus)) return true
    return false
  }

  function statusLabel(match) {
    if (match.status === 'open') return match.seated ? 'waiting for an opponent' : 'created, nobody paid'
    if (match.status === 'active') return 'in play, shot ' + (match.seq + 1)
    if (match.status === 'finished') return 'won by ' + (match.winner === 1 ? match.p1Name : match.p2Name)
    if (match.status === 'disputed') return 'DISPUTED: needs you'
    if (match.status === 'resolved') return 'settled by hand'
    return match.status
  }

  // What one recorded call to pay a payout invoice proved.
  const PAYOUT_WORDS = {
    bound: 'invoice recorded',
    started: 'payment started, result never recorded: it may have been paid',
    paid: 'paid',
    pending: 'in flight when last asked',
    refused: 'not sent',
    failed: 'failed at the node',
    dead: 'failed, and LNbits will not send this invoice again',
    unknown: 'result unclear: it may have been paid'
  }

  function payoutLabel(match) {
    if (match.payoutStatus === 'paid') return match.payoutAmount + ' sats paid'
    if (match.payoutStatus === 'failed') return 'FAILED: needs you'
    if (match.payoutStatus === 'unsent') return 'NOT SENT: needs you'
    if (match.payoutStatus === 'released') return 'FAILED: the player has to claim again'
    if (match.payoutStatus === 'unconfirmed') return 'UNCONFIRMED: check the wallet'
    if (match.payoutStatus === 'manual') return 'needs you'
    if (match.payoutStatus) return match.payoutStatus
    if (match.status === 'finished') return 'not claimed yet'
    if (match.status === 'cancelled' && match.seated) return 'refund not claimed yet'
    return ''
  }

  // ── Details and manual settlement ─────────────────────────────────────────

  async function openDetail(matchId) {
    try {
      showDetail(await bridge.api('GET', '/matches/' + encodeURIComponent(matchId) + '/admin'))
    } catch (error) {
      notice(error.message)
    }
  }

  function showDetail(detail) {
    app.detail = detail
    app.resolveArmed = false
    $('resolve').textContent = 'Mark as settled by hand'
    $('detail').hidden = !detail
    if (!detail) return
    const match = detail.match
    $('detail-title').textContent = 'Match ' + match.id
    $('detail-summary').textContent =
      statusLabel(match) + '. Stake ' + match.stake + ' sats each, ' + match.prize + ' sats to the winner' +
      (match.feePercent ? ' after a ' + match.feePercent + '% fee' : '') + '. ' +
      (payoutLabel(match) ? 'Payout: ' + payoutLabel(match) + (match.payoutHash ? ' (payment ' + match.payoutHash + ')' : '') + '. ' : '') +
      (match.note || '')

    const list = $('detail-players')
    list.replaceChildren()
    for (const player of detail.players) {
      const item = document.createElement('li')
      const seat = player.seat ? 'Seat ' + player.seat : player.status === 'pending' ? 'Unpaid invoice' : 'No seat'
      item.textContent = seat + ': ' + player.name +
        (player.paidAmount ? ', paid ' + player.paidAmount + ' sats' : '') + ' · payment ' + player.paymentHash
      list.append(item)
    }

    const payouts = $('detail-payouts')
    payouts.replaceChildren()
    for (const attempt of detail.payouts || []) {
      const item = document.createElement('li')
      item.textContent = 'Payout: ' + attempt.amount + ' sats to seat ' + attempt.seat + ', ' +
        PAYOUT_WORDS[attempt.status] + (attempt.detail ? ' (' + attempt.detail + ')' : '') + ' · payment ' + attempt.paymentHash
      payouts.append(item)
    }

    const verdict = judge(detail)
    $('detail-verdict').hidden = !verdict
    $('detail-verdict').textContent = verdict
    $('detail').scrollIntoView({block: 'nearest'})
  }

  // Re-run the shot the match is stuck on with the same engine the players
  // use, and say which reports agree with it.
  function judge(detail) {
    const evidence = detail.evidence
    const match = detail.match
    if (!evidence.shot || evidence.shot.seq !== match.seq) return ''
    if (!['disputed', 'active'].includes(match.status)) return ''
    const before = evidence.game || E.initialState(match.id)
    if (before.engine !== E.VERSION) {
      return 'This match was played with engine version ' + before.engine + '; this page has version ' + E.VERSION + ' and cannot replay it.'
    }
    const expected = E.runShot(before, evidence.shot.shot)
    const expectedJson = JSON.stringify(expected)
    const lines = evidence.reports.map(report => {
      if (report.seq !== match.seq || !report.result) return 'Seat ' + report.seat + ' has not reported.'
      return JSON.stringify(report.result) === expectedJson
        ? 'Seat ' + report.seat + ' reported what the simulation gives.'
        : 'Seat ' + report.seat + ' reported something else.'
    })
    const outcome = expected.winner
      ? 'seat ' + expected.winner + ' wins the match'
      : 'seat ' + expected.turn + ' shoots next'
    return 'Shot ' + (match.seq + 1) + ' by seat ' + evidence.shot.seat + ', replayed here: ' + outcome + '. ' + lines.join(' ')
  }

  async function resolveMatch() {
    if (!app.detail) return
    if (!app.resolveArmed) {
      app.resolveArmed = true
      $('resolve').textContent = 'Click again to confirm'
      return
    }
    try {
      await bridge.api('POST', '/matches/' + encodeURIComponent(app.detail.match.id) + '/resolve', {note: $('resolve-note').value})
      $('resolve-note').value = ''
      showDetail(null)
      await loadMatches()
      notice('Match marked as settled by hand.', true)
    } catch (error) {
      notice(error.message)
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function cell(text) {
    const td = document.createElement('td')
    td.textContent = text
    return td
  }

  function when(seconds) {
    return seconds ? new Date(seconds * 1000).toLocaleString() : ''
  }

  function goTo(path) {
    return bridge.navigate(path).catch(() => notice('Open ' + origin + path))
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text)
      notice('Copied.', true)
    } catch (_error) {
      notice('Copying is blocked here. Select the text and copy it by hand.')
    }
  }

  let noticeTimer = 0
  function notice(text, good) {
    const box = $('notice')
    box.textContent = text
    box.hidden = false
    box.classList.toggle('good', good === true)
    window.clearTimeout(noticeTimer)
    noticeTimer = window.setTimeout(() => {
      box.hidden = true
    }, 8000)
  }
})()
