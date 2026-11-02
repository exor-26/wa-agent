const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
console.log = (...args) => process.stderr.write(`${args.map(String).join(' ')}\n`)

function xmlText(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Documents with XML entity definitions are not supported.')
  return xml.replace(/<\/(?:w:p|a:p|row|si)>/g, '\n').replace(/<[^>]{0,1000}>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|apos);/g, value => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[value])
    .replace(/[ \t]+/g, ' ').trim()
}
async function office(file, extension) {
  const yauzl = require('yauzl')
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error) return reject(new Error('That Office document is damaged or encrypted.'))
      let count = 0, total = 0, actual = 0, parts = [], done = false
      const fail = err => { if (done) return; done = true; zip.close(); reject(err) }
      zip.on('error', () => fail(new Error('That Office document could not be read safely.')))
      zip.on('entry', entry => {
        if (++count > 2000 || (total += entry.uncompressedSize) > 20 * 1024 * 1024 || entry.generalPurposeBitFlag & 1) return fail(new Error('That document is too complex, compressed or encrypted. Please send a simpler PDF or text file.'))
        const wanted = extension === '.docx' ? /^word\/(document|header\d+|footer\d+)\.xml$/ : extension === '.pptx'
          ? /^ppt\/slides\/slide\d+\.xml$/ : /^xl\/(sharedStrings|worksheets\/sheet\d+)\.xml$/
        if (!wanted.test(entry.fileName)) { zip.readEntry(); return }
        zip.openReadStream(entry, (err, stream) => {
          if (err) return fail(new Error('That document entry is unreadable.'))
          const buffers = []
          stream.on('data', chunk => {
            actual += chunk.length
            if (actual > 20 * 1024 * 1024) { stream.destroy(); fail(new Error('Document expansion limit exceeded.')); return }
            buffers.push(chunk)
          })
          stream.on('error', () => fail(new Error('That document is damaged.')))
          stream.on('end', () => {
            if (done) return
            try { parts.push(`[${entry.fileName}]\n${xmlText(Buffer.concat(buffers).toString('utf8'))}`) }
            catch (err) { fail(err); return }
            zip.readEntry()
          })
        })
      })
      zip.on('end', () => { if (!done) { done = true; resolve(parts.join('\n').slice(0, 20000)) } })
      zip.readEntry()
    })
  })
}
async function readPdf(file, limits) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const loading = pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), isEvalSupported: false,
    useSystemFonts: false, disableFontFace: true, stopAtErrors: true })
  const document = await loading.promise
  try {
    if (document.numPages > limits.pages) throw new Error(`Please send a PDF with at most ${limits.pages} pages.`)
    let text = ''
    const images = []
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent()
      text += `\n[Page ${pageNumber}]\n${content.items.map(item => item.str || '').join(' ')}`
      if (text.length > 20000) break
    }
    const scanned = text.replace(/\[Page \d+\]/g, '').trim().length < 20
    {
      const { createCanvas } = require('@napi-rs/canvas')
      for (let n = 1; n <= Math.min(document.numPages, 3); n++) {
        const page = await document.getPage(n)
        const initial = page.getViewport({ scale: 1 })
        const viewport = page.getViewport({ scale: Math.min(2, 1400 / Math.max(initial.width, initial.height)) })
        if (!Number.isFinite(viewport.width) || viewport.width < 1 || viewport.height < 1) throw new Error('Invalid PDF dimensions.')
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
        await page.render({ canvasContext: canvas.getContext('2d'), canvas, viewport }).promise
        const output = path.join(path.dirname(file), `page-${n}.png`)
        fs.writeFileSync(output, canvas.toBuffer('image/png'), { mode: 0o600 }); images.push(output)
      }
      const note = `[${scanned ? 'Scanned PDF' : 'PDF visual previews'}: first ${images.length} of ${document.numPages} pages attached; other page graphics were not seen.]`
      text = scanned ? note : `${note}\n${text}`
    }
    return { text: text.slice(0, 20000), images, truncated: text.length > 20000 }
  } finally { await loading.destroy() }
}
async function speech(file, cache, limits, warm = false) {
  let samples
  if (!warm) {
    const ffmpeg = require('ffmpeg-static')
    const pcm = execFileSync(ffmpeg, ['-v', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe', '-i', file,
      '-t', String(limits.seconds + 1), '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1'],
    { timeout: 30000, maxBuffer: (limits.seconds + 2) * 16000 * 4, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    samples = new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength))
    if (samples.length > limits.seconds * 16000) throw new Error(`Voice/audio must be no longer than ${limits.seconds} seconds.`)
    if (samples.length < 1600) throw new Error('That recording is too short or empty. Please resend it.')
  }
  const { pipeline } = await import('@huggingface/transformers')
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 })
  const transcribe = await pipeline('automatic-speech-recognition', 'onnx-community/whisper-base', {
    cache_dir: cache, device: 'cpu', dtype: 'q8', session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 }
  })
  try {
    if (warm) return { text: 'Local multilingual voice transcription is ready.', images: [] }
    const result = await transcribe(samples, { task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 })
    if (!result.text?.trim()) throw new Error('I could not make out that recording. Please send clearer audio or text.')
    return { text: `[Voice/audio transcript; may contain recognition mistakes]\n${result.text.slice(0, 12000)}`, images: [] }
  } finally { await transcribe.dispose() }
}
async function processMedia({ file, metadata, limits, cache }) {
  if (metadata.kind === 'warm') return speech(file, cache, limits, true)
  const stat = fs.statSync(file)
  if (stat.size > limits[metadata.kind]) throw new Error('That attachment is too large. Please send a normal-sized file.')
  if (metadata.kind === 'photo' || metadata.kind === 'sticker') {
    const header = fs.readFileSync(file).subarray(0, 32)
    const raster = header[0] === 0xff && header[1] === 0xd8 || header.subarray(1, 4).toString() === 'PNG' ||
      header.subarray(0, 3).toString() === 'GIF' || header.subarray(8, 12).toString() === 'WEBP' ||
      ['II*\x00', 'MM\x00*'].includes(header.subarray(0, 4).toString()) ||
      header.subarray(4, 8).toString() === 'ftyp' && /^(avif|avis|heic|heix|hevc|hevx|mif1|msf1)$/.test(header.subarray(8, 12).toString())
    if (!raster) throw new Error('Please send a normal JPEG, PNG, WebP or other raster photo. SVG and arbitrary image documents are not processed.')
    const output = path.join(path.dirname(file), 'image.jpg')
    await require('sharp')(file, { limitInputPixels: 32000000, pages: 1 }).rotate().resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#fff' }).jpeg({ quality: 88 }).toFile(output)
    fs.chmodSync(output, 0o600)
    return { images: [output], text: metadata.kind === 'sticker' ? '[Sticker: first frame only]' : '' }
  }
  if (metadata.kind === 'audio') return speech(file, cache, limits)
  const extension = path.extname(metadata.name || '').toLowerCase()
  const header = fs.readFileSync(file).subarray(0, 8)
  if (extension === '.pdf' && header.toString().startsWith('%PDF-')) return readPdf(file, limits)
  if (['.docx', '.xlsx', '.pptx'].includes(extension) && header.subarray(0, 2).toString() === 'PK') {
    const text = await office(file, extension)
    if (!text.trim()) throw new Error('No readable text was found. Please send a PDF or screenshots.')
    return { text: `[Document text excerpt; layout/formulas/macros are not executed]\n${text}`, images: [], truncated: text.length >= 20000 }
  }
  if (['.txt', '.md', '.csv', '.json', '.rtf'].includes(extension)) {
    const data = fs.readFileSync(file)
    if (data.includes(0) || data.subarray(0, 2).toString() === 'MZ') throw new Error('That file is not a supported text document.')
    const text = extension === '.rtf' ? data.toString('utf8').replace(/\\[a-z]+-?\d* ?|[{}]/gi, ' ') : data.toString('utf8')
    return { text: text.slice(0, 20000), images: [], truncated: text.length > 20000 }
  }
  throw new Error('Supported documents are PDF, DOCX, XLSX, PPTX, TXT, Markdown, CSV, JSON and RTF. Video, executable files and arbitrary archives are not processed.')
}
async function main() {
  let input = ''
  for await (const chunk of process.stdin) { input += chunk; if (input.length > 20000) throw new Error('Invalid media request') }
  try { process.stdout.write(JSON.stringify(await processMedia(JSON.parse(input)))) }
  catch (error) {
    const message = /Command failed|fetch failed|fetch request failed|ONNX|TypeError|ENOMEM/i.test(error.message)
      ? 'Media processing is temporarily unavailable. Please send text or a smaller attachment.' : String(error.message).slice(0, 300)
    process.stdout.write(JSON.stringify({ error: message })); process.exitCode = 1
  }
}
if (require.main === module) main().catch(() => { process.stdout.write(JSON.stringify({ error: 'Unable to process that attachment.' })); process.exitCode = 1 })
module.exports = { processMedia, xmlText }
