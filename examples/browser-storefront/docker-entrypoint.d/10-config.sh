#!/bin/sh
# Writes config.js from the environment at container start, so the image carries no
# keys and one image works in any environment.
set -e
cat > /usr/share/nginx/html/config.js <<CONFIG
window.NORTHWIND_CONFIG = {
  endpoint: "${ZIPLOGGER_ENDPOINT:-https://app.ziplogger.dev}",
  apiKey: "${ZIPLOGGER_BROWSER_API_KEY:-}",
  apiBase: "${CHECKOUT_API_BASE:-/checkout}",
  environment: "${ZIPLOGGER_ENVIRONMENT:-production}"
}
CONFIG
echo "storefront: config.js written (endpoint=${ZIPLOGGER_ENDPOINT:-https://app.ziplogger.dev} api=${CHECKOUT_API_BASE:-/checkout})"
