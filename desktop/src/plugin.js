// threejs-stage — Desktop half. Draws three_scene results as a live, sandboxed scene card.
// Source of desktop/plugin.js: `node scripts/build.mjs` inlines stage/guest.html as GUEST_URL.
import * as sdk from '@hermes/plugin-sdk'
import { Button, Codicon, Input, SandboxedFrame, atom, host, useValue } from '@hermes/plugin-sdk'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const GUEST_URL = '__GUEST_URL__'
const TOOL = 'three_scene'
const MAX_MESSAGE = 1800
const SLEEP_AFTER_MS = 30000

let CTX = null
let runtimePromise = null

/** The vendored three.js r187 sources, fetched once per app session from our own backend. */
function loadRuntime() {
  if (!runtimePromise) {
    runtimePromise = CTX.rest('/runtime', { timeoutMs: 60000 }).then(
      (rt) => {
        if (!rt || !rt.build || !rt.addons) throw new Error('unexpected /runtime payload')
        return rt
      },
      (err) => {
        runtimePromise = null
        throw err
      }
    )
  }
  return runtimePromise
}

/** Only the addons a scene can reach: its own imports, what the harness loads, and their imports. */
function runtimeFor(rt, code, model) {
  const want = ['controls/OrbitControls.js']
  if (model) {
    want.push('environments/RoomEnvironment.js')
    if (model.kind === 'stl') want.push('loaders/STLLoader.js')
    else if (model.kind === 'obj') want.push('loaders/OBJLoader.js', 'loaders/MTLLoader.js')
    else want.push('loaders/GLTFLoader.js')
  }
  for (const m of String(code || '').matchAll(/three\/addons\/([\w./-]+?\.js)/g)) want.push(m[1])
  const addons = {}
  while (want.length) {
    const rel = want.pop()
    const src = rt.addons[rel]
    if (typeof src !== 'string' || rel in addons) continue
    addons[rel] = src
    const dir = rel.split('/').slice(0, -1)
    for (const m of src.matchAll(/(?:from|import)\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const parts = dir.slice()
      for (const seg of m[1].split('/')) { if (seg === '..') parts.pop(); else if (seg !== '.') parts.push(seg) }
      want.push(parts.join('/'))
    }
  }
  return { revision: rt.revision, build: rt.build, addons }
}

// ---- dry runs ----
// While a three_scene call is running, its tool waits for one Desktop window to run the scene in
// a hidden frame and report what happened, so Hermes can repair a crash in the same turn.
const VERIFY_WATCH_MS = 6000
const VERIFY_POLL_MS = 250
const VERIFY_LIMIT_MS = 14000
const verifyJobs = atom([])
let verifyWatchUntil = 0
let verifyWatching = false
let verifyHostMounted = false

async function watchForVerify() {
  verifyWatchUntil = Date.now() + VERIFY_WATCH_MS
  if (verifyWatching) return
  verifyWatching = true
  try {
    while (Date.now() < verifyWatchUntil) {
      let next = null
      try {
        // Claim a job only when the hidden host is mounted to run it.
        next = verifyHostMounted ? await CTX.rest('/verify/next', { method: 'POST', body: {} }) : null
      } catch (err) { // the tool times out and reports the scene as unverified
        console.warn('[threejs-stage] dry run unavailable:', (err && err.message) || err)
        return
      }
      if (next && next.id) {
        verifyJobs.set([...verifyJobs.get(), next])
        verifyWatchUntil = Date.now() + VERIFY_WATCH_MS
      }
      await new Promise((resolve) => CTX.setTimeout(resolve, VERIFY_POLL_MS))
    }
  } finally {
    verifyWatching = false
  }
}

function VerifyRun({ job }) {
  const frameRef = useRef(null)
  const [boot, setBoot] = useState(null)
  useEffect(() => {
    let live = true
    let reported = false
    const errors = []
    const finish = (outcome) => {
      if (reported) return
      reported = true
      window.removeEventListener('message', onMessage)
      clearTimeout(limit)
      CTX.rest('/verify/result', { method: 'POST', body: { id: job.id, errors, ...outcome } }).catch(() => {})
      verifyJobs.set(verifyJobs.get().filter((j) => j.id !== job.id))
    }
    const onMessage = (e) => {
      const frame = frameRef.current
      const m = e.data
      if (!frame || e.source !== frame.contentWindow || !m || m.__threeStage !== 1) return
      if (m.t === 'ready') {
        Promise.all([loadRuntime(), job.hasModel ? CTX.rest(`/model?id=${encodeURIComponent(job.id)}`, { timeoutMs: 30000 }) : null]).then(
          ([runtime, model]) => { if (live) frame.contentWindow.postMessage({ t: 'boot', verify: true, runtime: runtimeFor(runtime, job.code, model), code: job.code, model }, '*') },
          (err) => finish({ status: 'timeout', detail: String(err) })
        )
      } else if (m.t === 'error') {
        if (errors.length < 8) errors.push({ kind: m.kind, name: m.name, message: m.message, line: m.line, codeFrame: m.codeFrame })
        if (m.kind !== 'console') finish({ status: 'failed', backend: m.backend })
      } else if (m.t === 'verified') {
        finish({ status: 'passed', backend: m.backend, frames: m.frames, drawCalls: m.drawCalls, triangles: m.triangles, pixels: m.pixels })
      }
    }
    window.addEventListener('message', onMessage)
    const limit = setTimeout(() => finish({ status: 'timeout' }), VERIFY_LIMIT_MS)
    setBoot(true)
    return () => { live = false; finish({ status: 'timeout' }) }
  }, [job])
  if (!boot) return null
  return jsx(SandboxedFrame, { ref: frameRef, src: GUEST_URL, title: `Dry run of 3D scene ${job.id}`, sandbox: 'allow-scripts', style: { width: 480, height: 270, display: 'block' } })
}

// Lazy frames only load near the viewport, so this sits on screen but cannot be seen or clicked.
function VerifyHost() {
  const jobs = useValue(verifyJobs)
  useEffect(() => {
    verifyHostMounted = true
    return () => { verifyHostMounted = false }
  }, [])
  if (!jobs.length) return null
  return jsx('div', {
    'aria-hidden': true,
    style: { position: 'fixed', right: 0, bottom: 0, width: 480, height: 270, opacity: 0, pointerEvents: 'none', zIndex: -1, overflow: 'hidden' },
    children: jobs.map((job) => jsx(VerifyRun, { job }, job.id))
  })
}

function parseResult(result) {
  if (typeof result === 'string') {
    try { return JSON.parse(result) } catch { return null }
  }
  return result && typeof result === 'object' ? result : null
}

/** The colours behind the card, for a frame that cannot rely on being transparent. */
function cardTheme(el) {
  let background = ''
  for (let node = el; node && !background; node = node.parentElement) {
    const color = getComputedStyle(node).backgroundColor
    if (color && !/^(transparent|rgba\(\s*0,\s*0,\s*0,\s*0\s*\))$/.test(color)) background = color
  }
  return { background, colorScheme: getComputedStyle(document.documentElement).colorScheme || 'normal' }
}

function clip(text, n) {
  text = String(text || '')
  return text.length > n ? text.slice(0, n - 1) + '…' : text
}

function fixMessage(scene, backend, err) {
  const lines = [
    `The 3D scene "${scene.title}" (three_scene id ${scene.id}) failed in Hermes Desktop (${backend || 'unknown'} backend).`,
    `${err.kind} error: ${err.name}: ${clip(err.message, 600)}`
  ]
  if (err.line) lines.push(`At line ${err.line}${err.col ? `, column ${err.col}` : ''}:`, clip(err.codeFrame, 500))
  lines.push('Fix the scene and call three_scene again with the full corrected module.')
  return clip(lines.join('\n'), MAX_MESSAGE)
}

function changeMessage(scene, request) {
  const how = scene.hasModel
    ? `Call three_scene again with the full module and model="scene:${scene.id}" to reuse the same model (it is stage.model).`
    : 'Call three_scene again with the full updated module.'
  return clip(`Change the 3D scene "${scene.title}" (three_scene id ${scene.id}): ${request.trim()}\n${how}`, MAX_MESSAGE)
}

function statsLine(s) {
  const n = (v) => Number(v || 0).toLocaleString()
  const parts = [
    String(s.kind || '').toUpperCase(),
    Number(s.bytes || 0) >= 1e6 ? `${(s.bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(Number(s.bytes || 0) / 1e3))} KB`,
    `${n(s.triangles)} triangle${s.triangles === 1 ? '' : 's'}`,
    `${n(s.meshes)} mesh${s.meshes === 1 ? '' : 'es'}`
  ]
  if (s.animations) parts.push(`${n(s.animations)} animation${s.animations === 1 ? '' : 's'}`)
  return parts.join(' \u00b7 ')
}

function iconButton({ icon, label, onClick, disabled, active }) {
  return jsx(Button, {
    type: 'button',
    variant: active ? 'secondary' : 'ghost',
    size: 'sm',
    disabled,
    onClick,
    title: label,
    'aria-label': label,
    style: { display: 'inline-flex', alignItems: 'center', gap: 6, width: 'auto', paddingInline: 8 },
    children: [jsx(Codicon, { name: icon }, 'i'), jsx('span', { children: label }, 'l')]
  })
}

function SceneCard({ args, result, sessionId, fallback }) {
  const res = useMemo(() => parseResult(result), [result])
  const sceneId = res && res.success && typeof res.scene_id === 'string' ? res.scene_id : null
  const title = clip((res && res.title) || (args && args.title) || '3D scene', 80)
  const argCode = args && typeof args.code === 'string' ? args.code : null
  const hasModel = !!(res && res.model) || !!(args && typeof args.model === 'string' && args.model)

  const wrapRef = useRef(null)
  const frameRef = useRef(null)
  const shotWait = useRef(null)
  const escapeRef = useRef(() => {})
  const visibleRef = useRef(true)
  const fullscreenRef = useRef(false)
  const [asleep, setAsleep] = useState(false)
  const [fixSent, setFixSent] = useState(false)
  const [code, setCode] = useState(null)
  const [runtime, setRuntime] = useState(null)
  const [model, setModel] = useState(null)
  const [stats, setStats] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [runKey, setRunKey] = useState(0)
  const [phase, setPhase] = useState('loading') // loading | running | error
  const [backend, setBackend] = useState(null)
  const [fps, setFps] = useState(null)
  const [errors, setErrors] = useState([])
  const [fullscreen, setFullscreen] = useState(false)
  const [asking, setAsking] = useState(false)
  const [request, setRequest] = useState('')
  const [busy, setBusy] = useState(false)

  // Scene code: the stored record (survives history rebuilds), else the call's own args.
  useEffect(() => {
    if (!sceneId) return
    let live = true
    CTX.rest(`/scene?id=${encodeURIComponent(sceneId)}`).then(
      (rec) => {
        if (!live) return
        const found = rec && typeof rec.code === 'string' ? rec.code : argCode
        if (found == null) setLoadError('the scene record has no code')
        else setCode(found)
      },
      (err) => {
        if (!live) return
        if (argCode == null) setLoadError(`the scene record could not be read: ${(err && err.message) || err}`)
        else setCode(argCode)
      }
    )
    return () => { live = false }
  }, [sceneId, argCode, runKey])

  useEffect(() => {
    if (!sceneId) return
    let live = true
    loadRuntime().then(
      (rt) => live && setRuntime(rt),
      (err) => live && setLoadError(String((err && err.message) || err))
    )
    return () => { live = false }
  }, [sceneId, runKey])

  useEffect(() => {
    if (!sceneId || !hasModel || model) return
    let live = true
    CTX.rest(`/model?id=${encodeURIComponent(sceneId)}`, { timeoutMs: 60000 }).then(
      (data) => {
        if (!live) return
        if (data && data.files) setModel(data)
        else setLoadError('the backend returned no model')
      },
      (err) => live && setLoadError(`could not load the model: ${(err && err.message) || err}`)
    )
    return () => { live = false }
  }, [sceneId, hasModel, model, runKey])

  // Messages from this card's frame only.
  useEffect(() => {
    const onMessage = (e) => {
      const frame = frameRef.current
      const m = e.data
      if (!frame || e.source !== frame.contentWindow || !m || m.__threeStage !== 1) return
      if (m.t === 'ready') {
        if (runtime && code != null) frame.contentWindow.postMessage({ t: 'boot', runtime: runtimeFor(runtime, code, model), code, model, theme: cardTheme(wrapRef.current), paused: !visibleRef.current, zoom: fullscreenRef.current }, '*')
      } else if (m.t === 'started') {
        setPhase((p) => (p === 'error' ? p : 'running'))
        setBackend(m.backend === 'WebGPU' ? 'WebGPU' : 'WebGL2')
      } else if (m.t === 'fps') {
        setFps(typeof m.fps === 'number' ? m.fps : null)
      } else if (m.t === 'model') {
        setStats(m.stats && typeof m.stats === 'object' ? m.stats : null)
      } else if (m.t === 'escape') {
        escapeRef.current()
      } else if (m.t === 'error') {
        if (m.backend) setBackend(m.backend === 'WebGPU' ? 'WebGPU' : 'WebGL2')
        const err = {
          kind: String(m.kind || 'runtime'), name: clip(m.name, 60), message: clip(m.message, 1500),
          line: Number.isInteger(m.line) ? m.line : null, col: Number.isInteger(m.col) ? m.col : null,
          codeFrame: clip(m.codeFrame, 800)
        }
        setErrors((list) => (list.length >= 6 || list.some((x) => x.message === err.message) ? list : [...list, err]))
        if (err.kind !== 'console') setPhase('error')
      } else if (m.t === 'shot' && shotWait.current) {
        shotWait.current(m)
        shotWait.current = null
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [runtime, code, model])

  // Pause the render loop while the card is off screen, and after a while free its GPU context:
  // browsers keep only about 16 alive, so a long chat of scenes would otherwise lose the oldest.
  useEffect(() => {
    const el = wrapRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    let sleepTimer = null
    const io = new IntersectionObserver(([entry]) => {
      visibleRef.current = entry.isIntersecting
      const w = frameRef.current && frameRef.current.contentWindow
      if (w) w.postMessage({ t: 'pause', paused: !entry.isIntersecting }, '*')
      clearTimeout(sleepTimer)
      if (entry.isIntersecting) setAsleep(false)
      else sleepTimer = setTimeout(() => setAsleep(true), SLEEP_AFTER_MS)
    })
    io.observe(el)
    return () => { io.disconnect(); clearTimeout(sleepTimer) }
  }, [sceneId])

  // A slept card starts fresh when it comes back.
  useEffect(() => {
    if (asleep) { setPhase('loading'); setFps(null) }
  }, [asleep])

  // Fullscreen fills the Hermes window through the top layer (a popover). The Fullscreen API is
  // not an option: Hermes only grants media permissions, and the sandboxed frame has no
  // allow="fullscreen". A popover needs no permission and does not reload the frame.
  const exitFullscreen = useCallback(() => {
    const el = wrapRef.current
    try { if (el && el.matches(':popover-open')) el.hidePopover() } catch {}
    if (el) el.removeAttribute('popover')
    setFullscreen(false)
    fullscreenRef.current = false
    const w = frameRef.current && frameRef.current.contentWindow
    if (w) w.postMessage({ t: 'zoom', always: false }, '*')
  }, [])

  // Escape outside the frame; the guest forwards its own Escape as {t:'escape'}.
  useEffect(() => {
    if (!fullscreen) return
    const onKey = (e) => { if (e.key === 'Escape') exitFullscreen() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [fullscreen, exitFullscreen])

  escapeRef.current = exitFullscreen
  const scene = { id: sceneId, title, hasModel }
  const restart = useCallback(() => {
    setErrors([]); setLoadError(null); setPhase('loading'); setFps(null); setBackend(null); setStats(null); setFixSent(false)
    setRunKey((k) => k + 1)
  }, [])

  const toggleFullscreen = useCallback(() => {
    const el = wrapRef.current
    if (!el) return
    if (fullscreen) return exitFullscreen()
    try {
      el.setAttribute('popover', 'manual')
      el.showPopover()
      setFullscreen(true)
      fullscreenRef.current = true
      const w = frameRef.current && frameRef.current.contentWindow
      if (w) w.postMessage({ t: 'zoom', always: true }, '*')
    } catch (err) {
      el.removeAttribute('popover')
      host.notify({ kind: 'warning', message: `Fullscreen unavailable: ${(err && err.message) || err}` })
    }
  }, [fullscreen, exitFullscreen])

  const screenshot = useCallback(async () => {
    const w = frameRef.current && frameRef.current.contentWindow
    if (!w || busy) return
    setBusy(true)
    try {
      const reply = await new Promise((resolve) => {
        shotWait.current = resolve
        w.postMessage({ t: 'shot' }, '*')
        setTimeout(() => resolve({ error: 'timed out' }), 5000)
      })
      if (!reply || !reply.dataUrl) throw new Error((reply && reply.error) || 'no image')
      const saved = await CTX.rest('/screenshot', { method: 'POST', body: { id: sceneId, data_url: reply.dataUrl }, timeoutMs: 30000 })
      host.notify({ kind: 'success', message: `Screenshot saved on the Hermes host: ${saved.path}` })
    } catch (err) {
      host.notify({ kind: 'error', message: `Screenshot failed: ${(err && err.message) || err}` })
    } finally {
      setBusy(false)
    }
  }, [busy, sceneId])

  const send = useCallback((text) => {
    const ok = host.composer.submit(sessionId ?? null, text)
    if (!ok) host.notify({ kind: 'warning', message: 'Open this chat to send that to Hermes.' })
    return ok
  }, [sessionId])

  if (!sceneId) return fallback ?? null

  const fatal = errors.find((e) => e.kind !== 'console')
  const ready = runtime && code != null && (!hasModel || model)

  const header = jsxs('div', {
    className: 'flex items-center gap-2 px-3 py-1.5 text-xs',
    style: { borderBottom: '1px solid var(--ui-border)' },
    children: [
      jsx(Codicon, { name: 'symbol-namespace', className: 'text-(--ui-text-tertiary)' }),
      jsx('span', { className: 'font-medium truncate', children: title }),
      jsx('span', { className: 'flex-1' }),
      backend && jsx('span', {
        title: backend === 'WebGPU' ? 'Running on WebGPU' : 'Running on WebGPURenderer’s WebGL2 backend (the sandboxed card is not a secure context, so WebGPU is unavailable)',
        className: 'rounded px-1.5 py-0.5 text-[0.6875rem] text-(--ui-text-secondary)',
        style: { border: '1px solid var(--ui-border)' },
        children: backend
      }),
      fps != null && phase === 'running' && jsx('span', { className: 'tabular-nums text-[0.6875rem] text-(--ui-text-tertiary)', children: `${fps} fps` }),
      jsx('span', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: 'three r187' })
    ]
  })

  let body
  if (loadError) {
    body = jsx('div', {
      className: 'flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-(--ui-text-secondary)',
      children: [
        jsx('div', { children: hasModel ? 'This model could not be loaded.' : 'The threejs-stage backend is not reachable, so the scene cannot run here.' }, 'a'),
        jsx('div', { className: 'text-xs text-(--ui-text-tertiary)', children: 'Enable the threejs-stage plugin for this profile (Capabilities → Plugins) and restart the gateway. ' + clip(loadError, 200) }, 'b')
      ]
    })
  } else if (asleep) {
    body = jsx('div', { className: 'flex h-full items-center justify-center text-xs text-(--ui-text-tertiary)', children: 'Paused while off screen' })
  } else if (!ready) {
    body = jsx('div', { className: 'flex h-full items-center justify-center text-xs text-(--ui-text-tertiary)', children: hasModel ? 'Loading model…' : 'Loading three.js r187…' })
  } else {
    body = jsx(SandboxedFrame, {
      ref: frameRef,
      src: GUEST_URL,
      title: `3D scene: ${title}`,
      sandbox: 'allow-scripts allow-pointer-lock',
      style: { width: '100%', height: '100%', display: 'block' }
    }, runKey)
  }

  const toolbar = jsxs('div', {
    className: 'flex flex-wrap items-center gap-1 px-2 py-1',
    style: { borderTop: '1px solid var(--ui-border)' },
    children: [
      iconButton({ icon: 'debug-restart', label: 'Restart', onClick: restart, disabled: !ready && !loadError }),
      iconButton({ icon: fullscreen ? 'screen-normal' : 'screen-full', label: fullscreen ? 'Exit fullscreen' : 'Fullscreen', onClick: toggleFullscreen, disabled: !ready }),
      iconButton({ icon: 'device-camera', label: 'Screenshot', onClick: screenshot, disabled: !ready || phase !== 'running' || busy }),
      jsx('span', { className: 'flex-1' }),
      iconButton({ icon: 'sparkle', label: 'Ask Hermes to change this', onClick: () => setAsking((a) => !a), active: asking })
    ]
  })

  const ask = asking && jsxs('form', {
    className: 'flex items-center gap-2 px-2 pb-2',
    onSubmit: (e) => {
      e.preventDefault()
      if (!request.trim()) return
      if (send(changeMessage(scene, request))) { setRequest(''); setAsking(false) }
    },
    children: [
      jsx(Input, { autoFocus: true, value: request, maxLength: 1200, placeholder: 'e.g. make it night time and add fog', onChange: (e) => setRequest(e.target.value), className: 'h-8 flex-1 text-sm' }),
      jsx(Button, { type: 'submit', size: 'sm', disabled: !request.trim(), children: 'Send' })
    ]
  })

  const errorPanel = errors.length > 0 && jsxs('div', {
    className: 'flex flex-col gap-2 px-3 py-2 text-xs',
    style: { borderTop: '1px solid var(--ui-border)' },
    children: [
      ...errors.map((err, i) => jsxs('div', {
        className: 'flex flex-col gap-1',
        children: [
          jsx('div', { className: err.kind === 'console' ? 'text-(--ui-text-secondary)' : 'font-medium text-(--ui-text-primary)', children: `${err.kind} error${err.line ? ` at line ${err.line}` : ''}: ${err.message}` }),
          err.codeFrame && jsx('pre', { className: 'overflow-x-auto rounded p-2 text-[0.6875rem]', style: { background: 'var(--ui-bg-subtle, transparent)', border: '1px solid var(--ui-border)' }, children: err.codeFrame })
        ]
      }, i)),
      jsxs('div', {
        className: 'flex items-center gap-2',
        children: [
          jsx(Button, { type: 'button', size: 'sm', disabled: fixSent, onClick: () => { if (send(fixMessage(scene, backend, fatal || errors[0]))) setFixSent(true) }, children: [jsx(Codicon, { name: 'wrench' }, 'i'), jsx('span', { children: ' Fix with Hermes' }, 'l')] }),
          jsx('span', { className: 'text-(--ui-text-tertiary)', children: fixSent ? 'Sent to Hermes.' : 'Sends this error to the chat as a message.' })
        ]
      })
    ]
  })

  return jsxs('div', {
    ref: wrapRef,
    className: 'my-2 flex w-full flex-col overflow-hidden rounded-lg',
    style: { maxWidth: 760, border: '1px solid var(--ui-border)', background: 'var(--ui-bg-elevated, var(--ui-bg))', ...(fullscreen ? { position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', width: '100%', height: '100%', maxWidth: 'none', margin: 0, border: 0, borderRadius: 0, padding: 0 } : {}) },
    children: [
      header,
      jsx('div', { className: 'relative', style: fullscreen ? { flex: '1 1 0', minHeight: 0 } : { height: 380, minHeight: 240 }, children: body }),
      stats && jsx('div', { className: 'px-3 pt-1 text-[0.6875rem] tabular-nums text-(--ui-text-tertiary)', children: statsLine(stats) }),
      toolbar,
      ask,
      errorPanel
    ]
  })
}

export default {
  id: 'threejs-stage',
  name: 'Three.js Stage',
  register(ctx) {
    CTX = ctx
    runtimePromise = null
    // Older Desktops don't export the area: they keep the built-in file card.
    if (typeof sdk.TOOL_MEDIA_RENDERER_AREA !== 'string') return
    ctx.register({
      id: 'scene-card',
      area: sdk.TOOL_MEDIA_RENDERER_AREA,
      data: { tools: [TOOL], render: (props) => jsx(SceneCard, props) }
    })
    ctx.register({ id: 'verify-host', area: 'statusBar.right', order: 9999, render: () => jsx(VerifyHost, {}) })
    ctx.onEvent('tool.start', (event) => {
      const payload = (event && event.payload) || {}
      if (payload.name === TOOL || payload.tool_name === TOOL) watchForVerify()
    })
    ctx.onDispose(() => verifyJobs.set([]))
  }
}
