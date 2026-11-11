// Builds the throwaway feasibility probe plugin.
// Usage: node probe/build-probe.mjs <path-to-three-0.187.0/package> <out-plugin.js>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const [threeDir, outFile] = process.argv.slice(2)
if (!threeDir || !outFile) throw new Error('usage: build-probe.mjs <three package dir> <out plugin.js>')

const b64 = (p) => readFileSync(join(threeDir, 'build', p)).toString('base64')
const guest = readFileSync(join(here, 'guest.html'), 'utf8')
const guestUrl = 'data:text/html;base64,' + Buffer.from(guest).toString('base64')

const src = `// three-stage feasibility probe — temporary, not the product.
import { SandboxedFrame } from '@hermes/plugin-sdk'
import { useEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const GUEST = ${JSON.stringify(guestUrl)}
const THREE_B64 = ${JSON.stringify({ core: b64('three.core.js'), tsl: b64('three.tsl.js'), webgpu: b64('three.webgpu.js'), module: b64('three.module.js') })}

let decoded = null
function threeSources() {
  if (decoded) return decoded
  const dec = new TextDecoder()
  const one = (s) => dec.decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)))
  decoded = { core: one(THREE_B64.core), tsl: one(THREE_B64.tsl), webgpu: one(THREE_B64.webgpu), module: one(THREE_B64.module) }
  return decoded
}

let CTX = null
const SINK = (tag, body) => { try { fetch('http://127.0.0.1:47187/' + tag, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }).catch(() => {}) } catch {} }

function ProbeBox() {
  const ref = useRef(null)
  const [phase, setPhase] = useState(0)
  const [status, setStatus] = useState('starting')
  const [open, setOpen] = useState(true)
  useEffect(() => {
    SINK('mounted', 'x')
    const onMsg = async (e) => {
      const frame = ref.current
      if (!frame || e.source !== frame.contentWindow || !e.data || !e.data.__threeStageProbe) return
      if (e.data.type === 'need-src') { SINK('need-src', 'x'); setStatus('sending three.js'); frame.contentWindow.postMessage({ type: 'three-stage-probe-src', src: threeSources() }, '*') }
      if (e.data.type === 'baseline') SINK('baseline', e.data.results)
      if (e.data.type === 'baseline') console.log('[three-stage-probe] baseline', JSON.stringify(e.data.results))
      if (e.data.type === 'results') {
        const json = JSON.stringify(e.data.results, null, 2)
        console.log('[three-stage-probe] results', json); SINK('results', json)
        try { CTX.storage.set('results', e.data.results) } catch {}
        const w = CTX.files && (await CTX.files.writeText('data', 'probe-results.json', json))
        setStatus(w && w.ok ? 'done (saved)' : 'done (save failed: ' + (w && w.error) + ')'); setPhase((p) => p + 1)
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])
  if (!open) return jsx('span', { className: 'px-1.5 text-[0.6875rem] text-(--ui-text-tertiary)', children: '3D probe: ' + status })
  return jsxs('div', {
    style: { position: 'fixed', right: 12, bottom: 36, width: 360, height: 250, zIndex: 50, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--ui-border)', background: 'var(--ui-bg-elevated, var(--ui-bg))' },
    children: [
      jsxs('div', { className: 'flex items-center justify-between px-2 text-[0.6875rem] text-(--ui-text-tertiary)', style: { height: 22 }, children: [
        jsx('span', { children: 'three-stage probe: ' + status }),
        jsx('button', { type: 'button', onClick: () => setOpen(false), children: 'hide' })
      ] }),
      jsx('div', { style: { height: 228 }, children: phase === 0 ? jsx(SandboxedFrame, { key: 'a', ref, src: GUEST, title: 'three-stage WebGPU probe (data:)' }) : jsx(SandboxedFrame, { key: 'b', ref, src: 'http://127.0.0.1:47187/guest.html', title: 'three-stage WebGPU probe (localhost)' }) })
    ]
  })
}

export default {
  id: 'three-stage-probe',
  name: 'three-stage probe (temporary)',
  register(ctx) {
    CTX = ctx
    SINK('registered', String(Date.now()))
    ctx.register({ id: 'box', area: 'statusBar.right', order: 999, render: () => jsx(ProbeBox, {}) })
  }
}
`
mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, src)
console.log('wrote', outFile, (src.length / 1048576).toFixed(2) + ' MiB')
