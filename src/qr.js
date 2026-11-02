const QRCode = require('qrcode-terminal/vendor/QRCode')
const levels = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel')
const sharp = require('sharp')
async function qrPng(value) {
  const code = new QRCode(-1, levels.L)
  code.addData(value); code.make()
  const size = code.getModuleCount() + 8
  const pixels = Buffer.alloc(size * size, 255)
  for (let y = 0; y < size - 8; y++) for (let x = 0; x < size - 8; x++) {
    if (code.isDark(y, x)) pixels[(y + 4) * size + x + 4] = 0
  }
  return sharp(pixels, { raw: { width: size, height: size, channels: 1 } })
    .resize(size * 6, size * 6, { kernel: 'nearest' }).png().toBuffer()
}
module.exports = { qrPng }
