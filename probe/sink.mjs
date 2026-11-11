// Local-only result sink for the feasibility probe. Usage: node probe/sink.mjs <out-dir>
import { createServer } from 'node:http'
import { readFileSync, appendFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const outDir = process.argv[2]
mkdirSync(outDir, { recursive: true })
createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'content-type')
  if (req.method === 'OPTIONS') return res.end()
  if (req.method === 'GET' && req.url.startsWith('/guest.html')) {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    return res.end(readFileSync(new URL('./guest.html', import.meta.url)))
  }
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const tag = (req.url || '/').replace(/[^a-z0-9-]/gi, '_')
    appendFileSync(join(outDir, 'events.log'), `${new Date().toISOString()} ${tag} ${body.slice(0, 300)}\n`)
    if (body.length > 300) writeFileSync(join(outDir, tag + '.json'), body)
    res.end('ok')
  })
}).listen(47187, '127.0.0.1', () => console.log('sink on 127.0.0.1:47187'))
