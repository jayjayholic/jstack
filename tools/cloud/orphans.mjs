// Orphan commits: work that lives only on a branch a session or a train writes to on its own (a cloud session's
// `claude/*` branch, a `train/*` branch) and that no kept branch, patch, squash or merged pull request holds.
// A commit there never ships: the work branch, its PR and the integration branch never see it.
//   node tools/cloud/orphans.mjs [--rescue] [--trains] [--repo <dir>]
// A commit counts as kept when another non-session branch on origin reaches it, the same patch is on the work branch
// or an integration branch (cherry-pick, rebase), the integration branch already has the same content (a squash), or
// the tip is a merged pull request head (gh, when available). --rescue fast-forwards the work branch to the session
// branch; it never forces, and a work branch that moved on its own is listed as diverged for a person.
// Env: JSTACK_INTEGRATION_BRANCH (the branch PRs target), JSTACK_SESSION_BRANCH_PREFIX (default claude/).
import { spawnSync } from 'node:child_process'

const TRAIN_PREFIX = 'train/'
const SESSION_SUFFIX = /-[a-z0-9]{6}$/

const sessionPrefix = (env = process.env) => env.JSTACK_SESSION_BRANCH_PREFIX || 'claude/'
const ownPrefixes = (env) => [sessionPrefix(env), TRAIN_PREFIX]
const remoteRef = (b) => `refs/remotes/origin/${b}`

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { ok: r.status === 0, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() }
}

const resolve = (cwd, ref) => {
  const r = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd)
  return r.ok && r.stdout ? r.stdout : null
}

function remoteBranches(cwd) {
  const map = new Map()
  for (const line of git(['for-each-ref', '--format=%(refname:strip=3) %(objectname)', 'refs/remotes/origin'], cwd).stdout.split(/\r?\n/)) {
    const [name, sha] = line.split(' ')
    if (name && sha && name !== 'HEAD') map.set(name, sha)
  }
  return map
}

function integrationBranches(cwd, env = process.env) {
  const head = git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], cwd).stdout.replace(/^origin\//, '')
  return [...new Set([env.JSTACK_INTEGRATION_BRANCH, head, 'main', 'master'].filter(Boolean))].filter((b) => resolve(cwd, remoteRef(b)))
}

// With --remotes, git matches --exclude against names without the refs/remotes/ part.
function onlyOnOwnBranches(cwd, sha, env) {
  const excludes = ownPrefixes(env).map((p) => `--exclude=origin/${p}*`)
  const r = git(['rev-list', '--no-merges', sha, '--not', ...excludes, '--remotes=origin'], cwd)
  return r.ok ? r.stdout.split(/\r?\n/).filter(Boolean) : [sha]
}

function patchEquivalents(cwd, target, sha) {
  return new Set(git(['cherry', target, sha], cwd).stdout.split(/\r?\n/).filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim()))
}

function sameContent(cwd, target, sha) {
  const merged = git(['merge-tree', '--write-tree', target, sha], cwd)
  return merged.ok && merged.stdout.split(/\r?\n/)[0] === git(['rev-parse', `${target}^{tree}`], cwd).stdout
}

// The work branch a session branch belongs to: the one named after it (`<prefix><slug>-<6 chars>` -> `*/<slug>`), else
// the one non-session branch its tip descends from that is not already on an integration branch.
function workBranchFor(cwd, branch, branches = remoteBranches(cwd), env = process.env) {
  const sha = branches.get(branch)
  const prefixes = ownPrefixes(env)
  const candidates = [...branches.keys()].filter((b) => !prefixes.some((p) => b.startsWith(p)))
  const slug = branch.slice(sessionPrefix(env).length).replace(SESSION_SUFFIX, '')
  const named = candidates.filter((b) => b.split('/').pop() === slug)
  if (named.length === 1) return named[0]
  if (!sha) return null
  const integration = integrationBranches(cwd, env)
  const ancestors = candidates.filter((b) => {
    const tip = branches.get(b)
    if (integration.includes(b) || tip === sha || !git(['merge-base', '--is-ancestor', tip, sha], cwd).ok) return false
    return !integration.some((i) => git(['merge-base', '--is-ancestor', tip, remoteRef(i)], cwd).ok)
  })
  return ancestors.length === 1 ? ancestors[0] : null
}

function checkBranch(cwd, branch, workBranch, { mergedHeads = new Set(), env = process.env } = {}) {
  const sha = resolve(cwd, remoteRef(branch)) ?? ''
  const workSha = workBranch ? resolve(cwd, remoteRef(workBranch)) : null
  const fastForward = !workSha || git(['merge-base', '--is-ancestor', workSha, sha], cwd).ok
  const base = { branch, sha, workBranch, fastForward }
  if (!sha) return { ...base, safe: true, home: 'gone from origin', orphans: [] }
  if (mergedHeads.has(sha)) return { ...base, safe: true, home: 'a merged pull request', orphans: [] }
  const unique = onlyOnOwnBranches(cwd, sha, env)
  if (!unique.length) return { ...base, safe: true, home: 'another kept branch', orphans: [] }
  const targets = [...(workSha ? [workBranch] : []), ...integrationBranches(cwd, env)].map(remoteRef)
  const equivalent = new Set(targets.flatMap((t) => [...patchEquivalents(cwd, t, sha)]))
  const orphans = unique.filter((c) => !equivalent.has(c))
  if (!orphans.length) return { ...base, safe: true, home: 'the same patches elsewhere', orphans: [] }
  const holder = targets.find((t) => sameContent(cwd, t, sha))
  if (holder) return { ...base, safe: true, home: `${holder.replace('refs/remotes/origin/', '')} (same content)`, orphans: [] }
  return { ...base, safe: false, home: null, orphans }
}

function mergedPullHeads(cwd) {
  const slug = /github\.com[/:]([^/]+\/[^/.]+)/.exec(git(['remote', 'get-url', 'origin'], cwd).stdout)?.[1]
  if (!slug) return new Set()
  const r = spawnSync('gh', ['api', `repos/${slug}/pulls?state=closed&per_page=100`, '--jq', '.[] | select(.merged_at) | .head.sha'], { encoding: 'utf8', timeout: 30_000 })
  return new Set(r.status === 0 ? (r.stdout ?? '').split(/\r?\n/).filter(Boolean) : [])
}

function scan(cwd, { trains = false, mergedHeads = new Set(), env = process.env } = {}) {
  const branches = remoteBranches(cwd)
  const prefixes = trains ? ownPrefixes(env) : [sessionPrefix(env)]
  return [...branches.keys()].filter((b) => prefixes.some((p) => b.startsWith(p))).sort().map((b) =>
    checkBranch(cwd, b, b.startsWith(sessionPrefix(env)) ? workBranchFor(cwd, b, branches, env) : null, { mergedHeads, env }))
}

function rescue(cwd, check) {
  const { branch, workBranch, sha } = check
  if (!workBranch) return { branch, action: 'unknown-work-branch', detail: `no work branch found for ${branch}` }
  if (!check.fastForward) return { branch, action: 'diverged', detail: `${workBranch} moved on its own: merge origin/${branch} into it by hand, or open a draft PR from ${branch}` }
  const existed = Boolean(resolve(cwd, remoteRef(workBranch)))
  const push = git(['push', 'origin', `${sha}:refs/heads/${workBranch}`], cwd)
  if (!push.ok) return { branch, action: 'failed', detail: push.stderr }
  return { branch, action: existed ? 'pushed' : 'published', detail: `${workBranch} now at ${sha.slice(0, 9)}` }
}

function describe(c) {
  if (c.safe) return `safe     ${c.branch} -> ${c.workBranch ?? '?'}: in ${c.home}`
  return `ORPHAN   ${c.branch} -> ${c.workBranch ?? '?'}: ${c.orphans.length} commit(s) on no kept branch (${c.fastForward ? 'fast-forward' : 'diverged'})`
}

function main(argv, cwd = process.cwd()) {
  const at = argv.indexOf('--repo')
  const dir = at >= 0 ? argv[at + 1] : cwd
  git(['fetch', '--quiet', '--prune', 'origin'], dir)
  const checks = scan(dir, { trains: argv.includes('--trains'), mergedHeads: mergedPullHeads(dir) })
  let left = 0
  for (const c of checks) {
    console.log(describe(c))
    if (c.safe) continue
    if (!argv.includes('--rescue') || c.branch.startsWith(TRAIN_PREFIX)) { left++; continue }
    const r = rescue(dir, c)
    console.log(`  ${r.action}: ${r.detail}`)
    if (r.action !== 'pushed' && r.action !== 'published') left++
  }
  if (!checks.length) console.log('no session branches on origin')
  return left ? 1 : 0
}

if (process.argv[1]?.endsWith('orphans.mjs')) process.exit(main(process.argv.slice(2)))

export { checkBranch, describe, main, rescue, scan, workBranchFor }
