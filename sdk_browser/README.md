# @ziplogger/browser

Browser SDK for [ZipLogger](https://ziplogger.dev) — capture uncaught errors,
unhandled promise rejections, and custom events from web apps, with a first-class React error
boundary. Zero dependencies.

```bash
npm install @ziplogger/browser
```

## Quick start

```js
import { ZipLoggerBrowser } from '@ziplogger/browser'

export const ziplogger = new ZipLoggerBrowser({
  endpoint: 'https://logs.yourcompany.com',
  apiKey: 'zk_...',            // use a key dedicated to browser traffic
  release: import.meta.env.VITE_APP_VERSION,
})

ziplogger.captureGlobalErrors()  // window.onerror + unhandledrejection

ziplogger.log({ severity: 'info', message: 'checkout started', fields: { cartValue: 214.9 } })
try { risky() } catch (err) { ziplogger.captureError(err, { step: 'payment' }) }
```

Every event carries `url`, `userAgent`, and `environment` fields automatically; `Error` objects
map to ZipLogger's `stackTrace`. A final `fetch(…, { keepalive: true })` flush fires on
`pagehide` so events survive navigation and tab closes.

## React

```jsx
import React from 'react'
import { createErrorBoundary, createUseZipLogger } from '@ziplogger/browser/react'
import { ziplogger } from './ziplogger'

const ZipLoggerErrorBoundary = createErrorBoundary(React, ziplogger)
export const useZipLogger = createUseZipLogger(React, ziplogger)

root.render(
  <ZipLoggerErrorBoundary fallback={<p>Something went wrong.</p>}>
    <App />
  </ZipLoggerErrorBoundary>,
)

// in any component
const { captureError } = useZipLogger()
```

Render errors ship with the component stack; the factory pattern (`createErrorBoundary(React, …)`)
keeps this package free of a React dependency, so it works with any React ≥ 16.8 — and the core
client works with Vue, Svelte, Angular, or no framework at all.

## Notes

- Browser API keys are visible to users by design (like every client-side telemetry key). Use a
  dedicated key so it can be revoked independently, and rely on your plan's rate limits.
- Batching defaults are browser-tuned: 20 events/request, 3s linger, 2 retries, 1,000-event buffer.
