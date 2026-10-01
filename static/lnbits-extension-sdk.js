// Browser side of the LNbits extension bridge.
//
// An extension page runs in a sandboxed iframe with `connect-src 'none'`: it
// cannot fetch, open a websocket or read localStorage. Everything goes through
// a MessageChannel to the LNbits page that hosts the frame, which checks each
// request against the routes and permissions in config.json. The message
// shapes below are LNbits core's (static/js/wasm-extension-component.js).
;(function () {
  'use strict'

  const TIMEOUT_MS = 30000
  const eventHandlers = new Map()
  let portPromise = null

  function createLnbitsBridge(extensionId) {
    const apiBase = '/api/v1/ext/' + extensionId

    return {
      // {extensionId, public, routeParams, query}
      context() {
        return bridgeRequest({action: 'context'})
      },

      // Call one of this extension's API routes. Resolves with the route's
      // `data`, rejects with its `error`.
      api(method, path, body) {
        return bridgeRequest({
          action: 'api',
          method,
          path: apiBase + path,
          body: body === undefined || body === null ? null : JSON.parse(JSON.stringify(body))
        }).then(unwrap)
      },

      notify(message, level) {
        return bridgeRequest({action: 'ui.notify', level: level || 'info', message: String(message).slice(0, 500)})
      },

      // Per-tab storage kept by the host page (the frame has none of its own).
      getSession(key) {
        return bridgeRequest({action: 'storage.session.get', key}).then(result => String((result && result.value) || ''))
      },

      setSession(key, value) {
        return bridgeRequest({action: 'storage.session.set', key, value: String(value || '')})
      },

      // Go to another page of this extension, e.g. '/ext/lnpool/matches/m_1'.
      navigate(path) {
        return bridgeRequest({action: 'navigation.replace', path})
      },

      requestBackgroundPayments(grant, forcePrompt) {
        return bridgeRequest({action: 'permissions.request_background_payment', grant, forcePrompt: forcePrompt === true})
      },

      // Join an extension websocket channel. Resolves with {send, close}.
      // Anyone can publish on a channel, so treat what arrives as a hint.
      // `onError` fires when the socket fails; a socket that closes quietly
      // is not reported, so callers should not depend on it alone.
      subscribe(itemId, onMessage, onError) {
        const subscriptionId = requestId()
        eventHandlers.set(subscriptionId, event => {
          if (event.event === 'websocket.message') onMessage(event.data)
          else if (event.event === 'websocket.error' && onError) onError()
        })
        return bridgeRequest({action: 'websocket.subscribe', subscriptionId, itemId}).then(
          () => ({
            send(data) {
              return bridgeRequest({action: 'websocket.send', subscriptionId, data})
            },
            close() {
              eventHandlers.delete(subscriptionId)
              return bridgeRequest({action: 'websocket.unsubscribe', subscriptionId}).catch(() => {})
            }
          }),
          error => {
            eventHandlers.delete(subscriptionId)
            throw error
          }
        )
      }
    }
  }

  function bridgeRequest(message) {
    if (window.parent === window) return Promise.reject(new Error('This page only works inside LNbits.'))
    if (!portPromise) portPromise = connect()
    return portPromise.then(port => portRequest(port, message))
  }

  function connect() {
    const id = requestId()
    const channel = new MessageChannel()
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        channel.port1.close()
        portPromise = null
        reject(new Error('LNbits did not answer.'))
      }, TIMEOUT_MS)

      channel.port1.addEventListener('message', function onConnected(event) {
        const message = event.data
        if (!message || message.type !== 'lnbits-extension:connected' || message.id !== id) return
        window.clearTimeout(timeout)
        channel.port1.removeEventListener('message', onConnected)
        channel.port1.addEventListener('message', onEvent)
        resolve(channel.port1)
      })
      channel.port1.start()
      // The frame's own origin is opaque, but its URL is still the LNbits URL.
      window.parent.postMessage({type: 'lnbits-extension:connect', id}, new URL(window.location.href).origin, [channel.port2])
    })
  }

  function onEvent(event) {
    const message = event.data
    if (!message || message.type !== 'lnbits-extension:event') return
    const handler = eventHandlers.get(message.subscriptionId)
    if (handler) handler(message)
  }

  function portRequest(port, message) {
    const id = requestId()
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        port.removeEventListener('message', onResponse)
        reject(new Error('LNbits did not answer.'))
      }, TIMEOUT_MS)

      function onResponse(event) {
        const response = event.data
        if (!response || response.type !== 'lnbits-extension:response' || response.id !== id) return
        window.clearTimeout(timeout)
        port.removeEventListener('message', onResponse)
        if (response.ok === false) reject(new Error(response.error || 'The request failed.'))
        else resolve(response.data)
      }

      port.addEventListener('message', onResponse)
      port.postMessage({type: 'lnbits-extension:request', id, ...message})
    })
  }

  // API routes answer {ok: true, data} or {ok: false, error}.
  function unwrap(value) {
    const result = typeof value === 'string' ? JSON.parse(value) : value
    if (result && result.ok === false) throw new Error(result.error || 'The request failed.')
    if (result && result.ok === true) return result.data || {}
    return result || {}
  }

  function requestId() {
    return window.crypto && window.crypto.randomUUID
      ? window.crypto.randomUUID()
      : 'r_' + Date.now() + '_' + Math.random().toString(36).slice(2)
  }

  window.createLnbitsBridge = createLnbitsBridge
})()
