const path = require('node:path')
const { config } = require('../src/config')
const { MediaProcessor } = require('../src/media')

async function main() {
  console.log('Preparing the local multilingual voice model. This downloads model files, not your recordings.')
  const media = new MediaProcessor({ ...config, mediaTimeoutMs: 300000 })
  const result = await media.process(path.join(path.dirname(config.stateFile), 'setup-input'), { kind: 'warm' })
  console.log(result.text)
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
