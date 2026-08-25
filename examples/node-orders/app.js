/**
 * Northwind Coffee — orders service (Node.js).
 *
 * Uses Pino as the application logger and ships every line to ZipLogger through
 * the `ziplogger/pino` transport, which is how most Node services will adopt it:
 * no logging calls change, one transport is added.
 *
 * The service walks orders through a small state machine and logs what happened.
 * Orders that ask for more units than the warehouse holds throw a real
 * OutOfStockError, so the stack trace ZipLogger receives points at a real line
 * in this file.
 */

'use strict'

const pino = require('pino')

const ENDPOINT = process.env.ZIPLOGGER_ENDPOINT || 'https://app.ziplogger.dev'
const API_KEY = process.env.ZIPLOGGER_API_KEY || ''
const INTERVAL = Number(process.env.DEMO_INTERVAL_SECONDS || 5) * 1000

if (!API_KEY) {
  console.error('ZIPLOGGER_API_KEY is required')
  process.exit(1)
}

const logger = pino(
  { level: 'info' },
  pino.transport({
    target: 'ziplogger/pino',
    options: {
      endpoint: ENDPOINT,
      apiKey: API_KEY,
      source: 'orders',
      environment: process.env.ZIPLOGGER_ENVIRONMENT || 'production',
      tags: ['demo', 'node'],
    },
  })
)

const CATALOG = [
  { sku: 'ETH-YIRG-250', name: 'Ethiopia Yirgacheffe', price: 18.5, stock: 40 },
  { sku: 'COL-HUILA-1K', name: 'Colombia Huila 1kg', price: 42.0, stock: 12 },
  { sku: 'KEN-AA-250', name: 'Kenya AA', price: 21.0, stock: 25 },
  { sku: 'BRZ-SANTOS-500', name: 'Brazil Santos 500g', price: 15.75, stock: 60 },
  { sku: 'DECAF-SWP-250', name: 'Swiss Water Decaf', price: 19.25, stock: 8 },
]

const CHANNELS = ['web', 'mobile', 'wholesale-portal']

class OutOfStockError extends Error {
  constructor(sku, requested, available) {
    super(`Cannot reserve ${requested} of ${sku}: only ${available} in stock`)
    this.name = 'OutOfStockError'
    this.sku = sku
    this.requested = requested
    this.available = available
  }
}

function reserveStock(item, quantity) {
  if (quantity > item.stock) {
    throw new OutOfStockError(item.sku, quantity, item.stock)
  }
  item.stock -= quantity
  return item.stock
}

function restockOvernight() {
  for (const item of CATALOG) {
    if (item.stock < 5) {
      item.stock += 20 + Math.floor(Math.random() * 20)
      logger.info({ sku: item.sku, stock: item.stock }, 'Restocked from the roastery')
    }
  }
}

let placed = 0

function placeOrder() {
  const item = CATALOG[Math.floor(Math.random() * CATALOG.length)]
  const quantity = 1 + Math.floor(Math.random() * 6)
  const channel = CHANNELS[Math.floor(Math.random() * CHANNELS.length)]
  const orderId = `NW-${100000 + Math.floor(Math.random() * 899999)}`
  const total = Number((item.price * quantity).toFixed(2))

  const context = { orderId, sku: item.sku, quantity, channel, total }

  try {
    const remaining = reserveStock(item, quantity)
    placed += 1

    logger.info({ ...context, remainingStock: remaining }, 'Order accepted')

    if (remaining < 5) {
      logger.warn({ ...context, remainingStock: remaining }, 'Stock running low after order')
    }

    if (total > 200) {
      logger.warn({ ...context }, 'Large order flagged for manual review')
    }
  } catch (err) {
    // `err` is mapped to stackTrace + exception fields by the transport.
    logger.error({ ...context, err }, 'Order rejected')
  }

  if (placed % 25 === 0) restockOvernight()
}

logger.info({ catalogSize: CATALOG.length }, 'Orders service started')

const timer = setInterval(placeOrder, INTERVAL)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    clearInterval(timer)
    logger.info('Orders service stopping')
    // Give the transport a moment to flush before the process exits.
    setTimeout(() => process.exit(0), 2500)
  })
}
