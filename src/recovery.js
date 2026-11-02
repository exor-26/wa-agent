function backoff(attempt, { baseMs = 2000, maxMs = 60000, random = Math.random } = {}) {
  const delay = Math.min(maxMs, baseMs * 2 ** Math.min(Math.max(0, attempt - 1), 16))
  return Math.min(maxMs, Math.round(delay * (1 + random() * 0.2)))
}

function disconnectDetails(error) {
  const networkCodes = new Set()
  const seen = new Set()
  function visit(value, depth = 0) {
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 5) return
    seen.add(value)
    if (typeof value.code === 'string' && /^[A-Z][A-Z0-9_]{1,50}$/.test(value.code)) networkCodes.add(value.code)
    for (const item of [value.cause, value.data, ...(Array.isArray(value.errors) ? value.errors : [])]) visit(item, depth + 1)
  }
  visit(error)
  return { code: error?.output?.statusCode || null,
    message: String(error?.message || 'WhatsApp connection closed').replace(/[\r\n]/g, ' ').slice(0, 200),
    networkCodes: [...networkCodes] }
}

module.exports = { backoff, disconnectDetails }
