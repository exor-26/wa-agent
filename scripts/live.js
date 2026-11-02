const fs = require('node:fs')
const { config } = require('../src/config')
const { inspect } = require('../src/runtime')
const { control, waitForConnection } = require('./control')

function follow(file, { output = process.stdout, intervalMs = 500 } = {}) {
  let offset = fs.existsSync(file) ? fs.statSync(file).size : 0
  let reading = false
  const timer = setInterval(async () => {
    if (reading) return
    reading = true
    let handle
    try {
      handle = await fs.promises.open(file, 'r')
      const stat = await handle.stat()
      if (stat.size < offset) offset = 0
      if (stat.size > offset) {
        const buffer = Buffer.alloc(Math.min(stat.size - offset, 64 * 1024))
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
        offset += bytesRead
        output.write(buffer.subarray(0, bytesRead))
      }
    } catch (error) { if (error.code !== 'ENOENT') output.write(`Log read failed: ${error.message}\n`) }
    finally { if (handle) await handle.close(); reading = false }
  }, intervalMs)
  return () => clearInterval(timer)
}
async function main() {
  const status = inspect(config)
  console.log(`Current WhatsApp: ${status.connection.toUpperCase().replaceAll('_', ' ')}`)
  console.log('Live events from now. Ctrl+C closes this view; the supervised agent keeps running.')
  let stop = () => {}
  process.on('SIGINT', () => { stop(); process.exit(0) })
  process.on('SIGTERM', () => { stop(); process.exit(0) })
  try {
    // Startup may sanitize/replace the historical log; attach only after that step.
    const started = await control(process.argv.includes('--restart') ? 'restart' : 'start', { wait: false })
    stop = follow(started.logFile)
    const current = await waitForConnection()
    console.log(`Current WhatsApp: ${current.connection.toUpperCase().replaceAll('_', ' ')}`)
    if (current.connection === 'pairing') console.log(`QR image: ${current.qrFile}`)
    if (current.detail) console.log(JSON.stringify(current.detail))
  } catch (error) { console.error(error.message); stop(); process.exitCode = 1 }
}
if (require.main === module) main()
module.exports = { follow }
