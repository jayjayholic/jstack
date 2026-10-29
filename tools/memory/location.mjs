// Where project memory lives. Default: <repo>/.jstack/memory, committed with the branch, so a lesson rides with the
// code it's about. JSTACK_MEMORY_DIR (env, wins) or `git config jstack.memoryDir` (per repo, shared by every worktree,
// never committed) moves it to one folder that every worktree of the repo reads and writes. A relative value is
// resolved against the main checkout, so all worktrees land on the same folder. On Windows an MSYS path (/c/dev/x)
// is read as C:/dev/x.
import path from 'node:path'
import { git } from './anchors.mjs'

function fromMsys(p, platform = process.platform) {
  if (platform !== 'win32') return p
  const m = /^\/([a-zA-Z])(\/.*)?$/.exec(p)
  return m ? `${m[1].toUpperCase()}:${m[2] ?? '/'}` : p
}

// The main checkout's root (parent of the common .git), the same from every worktree.
function mainCheckout(repo) {
  const r = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!r.ok) return null
  const common = path.resolve(r.out.trim())
  return path.basename(common) === '.git' ? path.dirname(common) : null
}

const isInside = (parent, child) => {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

// { dir, entries, external, from, rel }. `external` = outside the repo's working tree: nothing there is committed, so
// the READY gate skips its "commit your entries" check and the scan never trusts suppressions from it in diff mode.
function memoryLocation(repo, env = process.env) {
  let raw = String(env.JSTACK_MEMORY_DIR ?? '').trim()
  let from = raw ? 'env JSTACK_MEMORY_DIR' : null
  if (!raw) {
    const r = git(repo, ['config', '--get', 'jstack.memoryDir'])
    if (r.ok && r.out.trim()) { raw = r.out.trim(); from = 'git config jstack.memoryDir' }
  }
  if (!raw) {
    const dir = path.join(repo, '.jstack', 'memory')
    return { dir, entries: path.join(dir, 'entries'), external: false, from: 'default', rel: '.jstack/memory' }
  }
  raw = fromMsys(raw)
  const dir = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(mainCheckout(repo) ?? repo, raw)
  const external = !isInside(repo, dir)
  return { dir, entries: path.join(dir, 'entries'), external, from, rel: external ? null : path.relative(repo, dir).replace(/\\/g, '/') }
}

export { memoryLocation, fromMsys, mainCheckout }
