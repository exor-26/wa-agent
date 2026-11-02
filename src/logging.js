const fs = require('node:fs')

const PRIVATE_FIELD = /^(priv(?:ate)?key|privatekey|rootkey|chainkey|messagekeys|_chains|currentratchet|sessionkey|identitykeypair|password|api_?key|access_?token|refresh_?token)$/i
const SESSION_DUMP = /^(Closing session:|Removing old closed session:|Session already closed)/

function sensitive(value, seen = new Set(), depth = 0) {
  if (!value || typeof value !== 'object' || seen.has(value)) return false
  if (Buffer.isBuffer(value)) return true
  if (depth > 6) return true
  seen.add(value)
  return Object.entries(value).some(([key, child]) => PRIVATE_FIELD.test(key) || sensitive(child, seen, depth + 1))
}
function installSafeConsole(target = console) {
  const originals = {}
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    originals[method] = target[method]
    target[method] = (...args) => {
      if (SESSION_DUMP.test(String(args[0])) || args.some(arg => sensitive(arg)) ||
          args.some(arg => typeof arg === 'string' && /(?:privKey|rootKey|chainKey)["']?\s*[:=]|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/i.test(arg))) {
        return originals[method].call(target, '[SESSION_DEBUG_REDACTED]')
      }
      return originals[method].apply(target, args)
    }
  }
  return () => { for (const method of Object.keys(originals)) target[method] = originals[method] }
}
function sanitizeLog(file) {
  if (!fs.existsSync(file)) return
  const input = fs.readFileSync(file, 'utf8')
  const lines = input.split(/\r?\n/)
  const safe = lines.filter(line => {
    const match = line.match(/^\[\d{4}-\d\d-\d\dT[^\]]+\] [A-Z_]+ (\{.*\})$/)
    if (!match) return line === '[SESSION_DEBUG_REDACTED]'
    try { return !sensitive(JSON.parse(match[1])) } catch { return false }
  })
  if (safe.length === lines.filter(Boolean).length) return
  const removedLines = lines.filter(Boolean).length - safe.length
  safe.push(`[${new Date().toISOString()}] LOG_SANITIZED ${JSON.stringify({ removedLines })}`)
  const temporary = `${file}.sanitized.tmp`
  fs.writeFileSync(temporary, `${safe.join('\n')}\n`, { mode: 0o600 })
  fs.renameSync(temporary, file)
  fs.chmodSync(file, 0o600)
}
module.exports = { installSafeConsole, sanitizeLog, sensitive }
