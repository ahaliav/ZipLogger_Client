/**
 * Northwind Coffee — storefront (browser).
 *
 * Shows the three things the browser SDK does that a server SDK cannot:
 *
 *   captureGlobalErrors()  uncaught errors and unhandled rejections are reported
 *                          with their stack, without wrapping any of your code
 *   instrumentFetch()      adds a W3C traceparent to API calls, so a click in the
 *                          browser and the server log it caused share one trace id
 *   log()                  ordinary product events, with whatever fields you want
 *
 * The API key here is visible to anyone who opens devtools. That is inherent to
 * browser telemetry, which is why this demo uses a key scoped to browser traffic
 * on a demo workspace rather than a production ingestion key.
 */

import ZipLoggerBrowser from './vendor/ziplogger-browser.js'

const config = window.NORTHWIND_CONFIG || {}
const API = (config.apiBase || 'http://localhost:5299').replace(/\/+$/, '')

const zl = new ZipLoggerBrowser({
  endpoint: config.endpoint || 'https://app.ziplogger.dev',
  apiKey: config.apiKey || '',
  source: 'storefront',
  environment: config.environment || 'production',
  tags: ['demo', 'browser'],
})

zl.captureGlobalErrors()
zl.instrumentFetch({ propagateTo: [API], logFailures: true, sendSpans: true })

const logEl = document.getElementById('log')

function show(message, kind) {
  const line = document.createElement('div')
  if (kind) line.className = kind
  line.textContent = `${new Date().toLocaleTimeString()}  ${message}`
  logEl.prepend(line)
}

async function loadCatalog() {
  const grid = document.getElementById('catalog')
  try {
    const response = await fetch(`${API}/api/products`)
    if (!response.ok) throw new Error(`Catalog request failed with ${response.status}`)
    const products = await response.json()

    zl.log({ severity: 'info', message: 'Catalog viewed', fields: { productCount: products.length } })

    grid.innerHTML = ''
    for (const product of products) {
      const card = document.createElement('div')
      card.className = 'card'
      card.innerHTML = `
        <h3>${product.name}</h3>
        <span class="sku">${product.sku}</span>
        <span class="price">${product.price.toFixed(2)} EUR</span>`
      const button = document.createElement('button')
      button.textContent = 'Buy one'
      button.addEventListener('click', () => checkout(product, 1))
      card.appendChild(button)
      grid.appendChild(card)
    }
    show(`Loaded ${products.length} products`, 'ok')
  } catch (error) {
    // captureError reports a caught error with context, unlike captureGlobalErrors
    // which handles the ones nobody caught.
    zl.captureError(error, { stage: 'catalog-load', api: API })
    grid.innerHTML = '<div class="card"><h3>Catalog unavailable</h3></div>'
    show(`Catalog failed: ${error.message}`, 'err')
  }
}

async function checkout(product, quantity) {
  const promoCode = document.getElementById('promo').value.trim()

  zl.log({
    severity: 'info',
    message: 'Checkout started',
    fields: { sku: product.sku, quantity, promoCode: promoCode || 'none' },
  })

  try {
    const response = await fetch(`${API}/api/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sku: product.sku, quantity, promoCode }),
    })

    if (!response.ok) {
      // The instrumented fetch already logged the failed request with its trace id.
      // This adds the business context the transport cannot know about.
      zl.log({
        severity: 'error',
        message: 'Checkout rejected by the API',
        fields: { sku: product.sku, quantity, promoCode, status: response.status },
      })
      show(`Checkout failed with ${response.status} (promo ${promoCode || 'none'})`, 'err')
      return
    }

    const order = await response.json()
    zl.log({
      severity: 'info',
      message: 'Checkout completed',
      fields: { orderId: order.orderId, sku: order.sku, total: order.total },
    })
    show(`Order ${order.orderId} placed for ${order.total.toFixed(2)} EUR`, 'ok')
  } catch (error) {
    zl.captureError(error, { stage: 'checkout', sku: product.sku })
    show(`Checkout error: ${error.message}`, 'err')
  }
}

document.getElementById('use-broken-promo').addEventListener('click', () => {
  document.getElementById('promo').value = 'SUMMER25'
  show('Promo set to SUMMER25, which the server has no rate for. Now buy something.')
})

document.getElementById('throw').addEventListener('click', () => {
  show('Throwing an uncaught error, captured by captureGlobalErrors()', 'err')
  // Deliberately unhandled: this is what a real front-end bug looks like.
  setTimeout(() => {
    const cart = null
    cart.items.push('ETH-YIRG-250')
  }, 0)
})

window.addEventListener('pagehide', () => zl.flush(true))

loadCatalog()
