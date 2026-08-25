// Local development only. The container overwrites this at start from environment
// variables (see docker-entrypoint.d/10-config.sh), so no key is ever baked into the image.
window.NORTHWIND_CONFIG = {
  endpoint: 'https://app.ziplogger.dev',
  apiKey: '',
  apiBase: 'http://localhost:5299',
  environment: 'development',
}
