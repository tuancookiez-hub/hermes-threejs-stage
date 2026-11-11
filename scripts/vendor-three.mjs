// Copies three.js r187 into vendor/three, verbatim (no edits), plus the curated addon list and
// every addon those import (relative imports are followed). Run once per three.js upgrade:
//   npm pack three@0.187.0 && tar -xzf three-0.187.0.tgz
//   node scripts/vendor-three.mjs <path-to-unpacked>/package
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = process.argv[2]
if (!pkg) throw new Error('usage: vendor-three.mjs <three package dir>')

const { version } = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'))
if (version !== '0.187.0') throw new Error(`expected three 0.187.0, got ${version}`)

// Addons scenes may import as `three/addons/<path>`. Keep in sync with skills/three-r187/SKILL.md.
export const ADDONS = [
  'controls/OrbitControls.js',
  'loaders/GLTFLoader.js', 'loaders/STLLoader.js', 'loaders/OBJLoader.js', 'loaders/MTLLoader.js',
  'utils/BufferGeometryUtils.js', 'utils/SkeletonUtils.js',
  'environments/RoomEnvironment.js',
  'geometries/RoundedBoxGeometry.js', 'geometries/ParametricGeometry.js', 'geometries/ParametricFunctions.js',
  'geometries/ConvexGeometry.js', 'geometries/TeapotGeometry.js',
  'math/ImprovedNoise.js', 'math/SimplexNoise.js', 'math/ConvexHull.js',
  'objects/SkyMesh.js', 'tsl/display/BloomNode.js'
]

const out = join(root, 'vendor', 'three')
rmSync(join(out, 'addons'), { recursive: true, force: true })
mkdirSync(join(out, 'build'), { recursive: true })
for (const f of ['three.core.js', 'three.tsl.js', 'three.webgpu.js']) copyFileSync(join(pkg, 'build', f), join(out, 'build', f))
copyFileSync(join(pkg, 'LICENSE'), join(out, 'LICENSE'))

const seen = new Set()
const queue = [...ADDONS]
const importRe = /(?:from|import)\s*['"](\.{1,2}\/[^'"]+)['"]/g
while (queue.length) {
  const rel = queue.shift()
  if (seen.has(rel)) continue
  seen.add(rel)
  const src = readFileSync(join(pkg, 'examples', 'jsm', rel), 'utf8')
  const dest = join(out, 'addons', rel)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, src)
  for (const m of src.matchAll(importRe)) queue.push(posix.normalize(posix.join(posix.dirname(rel), m[1])))
}

const manifest = { three: version, revision: '187', build: ['three.core.js', 'three.tsl.js', 'three.webgpu.js'], addons: [...seen].sort(), public: ADDONS }
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(`vendored three ${version}: 3 build files, ${seen.size} addon files`)
