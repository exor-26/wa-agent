const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const sharp = require('sharp')
const { config } = require('../src/config')
const { MediaProcessor } = require('../src/media')
const { Codex } = require('../src/codex')

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clara-vision-smoke-'))
  try {
    const media = new MediaProcessor(config), images = []
    for (const color of ['red', 'green', 'blue']) {
      const folder = path.join(root, color); fs.mkdirSync(folder)
      const file = path.join(folder, 'input')
      await sharp({ create: { width: 96, height: 96, channels: 3, background: color } }).png().toFile(file)
      const result = await media.process(file, { kind: 'photo', name: 'synthetic.png' })
      images.push(result.images[0])
    }
    const result = await new Codex(config).generate({ mode: 'OWNER', owner: 'Aditya', currentTime: new Date().toISOString(),
      profile: { timezone: 'Asia/Kolkata' }, contacts: [], concerns: [], linkedThreads: [], ownerFacts: [] },
    [{ role: 'owner', text: 'Name the solid color in each of the three attached image files. One short sentence, no actions.' }], { images })
    for (const color of ['red', 'green', 'blue']) assert.match(result.reply || '', new RegExp(color, 'i'))
    assert.equal(result.actions.length, 0)
    console.log('PASS: three locally normalized image/page previews reached Codex and were read correctly. No WhatsApp sends.')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
