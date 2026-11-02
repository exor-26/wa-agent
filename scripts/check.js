const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const files = ['index.js', ...['src', 'scripts', 'test'].flatMap(dir =>
  fs.readdirSync(path.join(root, dir)).filter(f => f.endsWith('.js')).map(f => path.join(dir, f)))]
for (const file of files) execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'inherit' })
console.log(`Syntax checked ${files.length} JavaScript files.`)
