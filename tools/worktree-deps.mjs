#!/usr/bin/env node
// Worktrees share node_modules and generated code instead of making their own. With ~10 agents on one laptop,
// every install wrote ~170k files that the antivirus scanned, refilling the Windows file cache to 10-16 GB.
// Called by new-worktree.sh --install and clean-worktrees.sh; run it by hand inside a worktree:
//
//   node scripts/worktree-deps.mjs deps [--base <ref>]   link node_modules to the shared store, or install its own
//   node scripts/worktree-deps.mjs generated              link the generated folder to the shared store, or generate
//   node scripts/worktree-deps.mjs own <deps|generated>   opt this worktree out: its own copy, kept on later runs
//   node scripts/worktree-deps.mjs share <deps|generated> opt back in and link the shared store again
//   node scripts/worktree-deps.mjs detach <path>          turn a linked path back into an own, empty one
//   node scripts/worktree-deps.mjs status                 what this worktree links to
//   node scripts/worktree-deps.mjs prune                  delete stores no worktree links to any more
//   node scripts/worktree-deps.mjs remove <worktree> [--delete-branch]
//                                                         unlink every junction, then git worktree remove
//
// NEVER remove a linked worktree with a bare `git worktree remove` or `rm -rf` on Windows: Git for Windows 2.40
// followed the junctions and deleted the shared store's files (seen 2026-10-25). `remove` unlinks them first.
//
// Shared by default, and each agent decides: `own <thing>` gives this worktree its own copy (the store is only read,
// never written) and every later `deps`/`generated` run keeps it, until `share <thing>`. Without that choice an own
// copy is made only when this branch changed the input versus its merge-base with <base>:
// dependency fields of every package.json, lockfiles, bunfig.toml, patches/ for node_modules; uncommitted edits
// under the codegen inputs for the generated folder. Stores are built once, under a lock, and never edited.
// Workspace packages always link to THIS worktree's own sources, never the store's.
// Settings (env, all optional): JSTACK_INTEGRATION_BRANCH (stage), JSTACK_INSTALL_CMD (bun install),
// WORKTREE_DEPS_STORE_INSTALL (bun install --frozen-lockfile), JSTACK_CODEGEN_CMD (bun run db:generate),
// JSTACK_CODEGEN_INPUTS (schema bun.lock: the generator version lives in the lockfile), JSTACK_CODEGEN_REUSE_PATHS (first entry: .generated), JSTACK_CODEGEN_REQUIRED,
// WORKTREE_DEPS_STORES (<main checkout>/.worktrees).
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const env = process.env
const words = (value, fallback) => (value === undefined ? fallback : value.trim() ? value.trim().split(/\s+/) : [])
const CONFIG = {
	base: `origin/${env.JSTACK_INTEGRATION_BRANCH || 'stage'}`,
	install: env.JSTACK_INSTALL_CMD || 'bun install',
	storeInstall: env.WORKTREE_DEPS_STORE_INSTALL || 'bun install --frozen-lockfile',
	codegen: env.JSTACK_CODEGEN_CMD ?? 'bun run db:generate',
	codegenInputs: words(env.JSTACK_CODEGEN_INPUTS, ['schema', 'bun.lock']),
	generatedDir: words(env.JSTACK_CODEGEN_REUSE_PATHS, ['.generated'])[0] ?? null,
	required: words(env.JSTACK_CODEGEN_REQUIRED, []),
}
const DEP_FILES = ['bun.lock', 'bun.lockb', 'bunfig.toml', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', '.npmrc']
const DEP_FIELDS = [
	'name',
	'workspaces',
	'dependencies',
	'devDependencies',
	'optionalDependencies',
	'peerDependencies',
	'overrides',
	'resolutions',
	'patchedDependencies',
	'trustedDependencies',
]
const MARKER = '.shared-deps'
const PER_TREE_ENTRIES = new Set(['.cache', '.vite', '.vite-temp'])
const LOCK_WAIT_MS = 30 * 60 * 1000

const git = (cwd, ...args) =>
	execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
const gitOrNull = (cwd, ...args) => {
	try {
		return git(cwd, ...args)
	} catch {
		return null
	}
}
const lines = (text) => (text ?? '').split('\n').filter(Boolean)

const worktreeRoot = () => path.resolve(git(process.cwd(), 'rev-parse', '--show-toplevel').trim())
const worktreeList = (cwd) => lines(git(cwd, 'worktree', 'list', '--porcelain')).filter((line) => line.startsWith('worktree ')).map((line) => path.resolve(line.slice(9)))
const mainCheckout = (cwd) => worktreeList(cwd)[0]
const storesRoot = (cwd) => path.resolve(env.WORKTREE_DEPS_STORES || path.join(mainCheckout(cwd), '.worktrees'))
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

const isLink = (target) => {
	try {
		return fs.lstatSync(target).isSymbolicLink()
	} catch {
		return false
	}
}
const exists = (target) => fs.existsSync(target) || isLink(target)
const junction = (target, at) => fs.symlinkSync(target, at, 'junction')
const toLf = (text) => text.replace(/\r\n/g, '\n')
const hashOf = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)

const workspacePatterns = (manifestText) => {
	const workspaces = JSON.parse(manifestText).workspaces
	return (Array.isArray(workspaces) ? workspaces : (workspaces?.packages ?? [])).map((pattern) => pattern.replace(/\/+$/, ''))
}

const expandWorkspaces = (patterns, listDir) =>
	patterns
		.flatMap((pattern) => (pattern.endsWith('/*') ? listDir(pattern.slice(0, -2)).map((dir) => `${pattern.slice(0, -2)}/${dir}`) : [pattern]))
		.sort()

const workingTreeReader = (root) => ({
	read: (file) => (fs.existsSync(path.join(root, file)) ? toLf(fs.readFileSync(path.join(root, file), 'utf8')) : null),
	list: (dir) =>
		fs.existsSync(path.join(root, dir))
			? fs
					.readdirSync(path.join(root, dir), { withFileTypes: true })
					.filter((entry) => entry.isDirectory())
					.map((entry) => entry.name)
			: [],
})

const commitReader = (root, commit) => ({
	read: (file) => {
		const text = gitOrNull(root, 'show', `${commit}:${file}`)
		return text === null ? null : toLf(text)
	},
	list: (dir) => lines(gitOrNull(root, 'ls-tree', '-d', '--name-only', `${commit}:${dir}`)),
	files: (dir) => lines(gitOrNull(root, 'ls-tree', '--name-only', `${commit}:${dir}`)),
})

const depInputs = (reader, root) => {
	const pick = (text) => {
		const json = JSON.parse(text)
		return Object.fromEntries(DEP_FIELDS.filter((key) => key in json).map((key) => [key, json[key]]))
	}
	const rootManifest = reader.read('package.json')
	const inputs = [['package.json', pick(rootManifest)]]
	for (const dir of expandWorkspaces(workspacePatterns(rootManifest), reader.list)) {
		const text = reader.read(`${dir}/package.json`)
		if (text !== null) inputs.push([`${dir}/package.json`, pick(text)])
	}
	for (const file of DEP_FILES) {
		const text = reader.read(file)
		if (text !== null) inputs.push([file, text])
	}
	const patchFiles = reader.files ? reader.files('patches') : fs.existsSync(path.join(root, 'patches')) ? fs.readdirSync(path.join(root, 'patches')) : []
	for (const file of patchFiles.sort()) inputs.push([`patches/${file}`, createHash('sha256').update(reader.read(`patches/${file}`) ?? '').digest('hex')])
	return inputs
}

const changedDepFiles = (root, base) => {
	const mergeBase = gitOrNull(root, 'merge-base', 'HEAD', base)?.trim()
	if (!mergeBase) return [`no merge-base with ${base}`]
	const now = depInputs(workingTreeReader(root), root)
	const then = new Map(depInputs(commitReader(root, mergeBase), root).map(([file, value]) => [file, JSON.stringify(value)]))
	const changed = now.filter(([file, value]) => then.get(file) !== JSON.stringify(value)).map(([file]) => file)
	for (const file of then.keys()) if (!now.some(([name]) => name === file)) changed.push(file)
	return changed
}

const withLock = (lockDir, work) => {
	const start = Date.now()
	for (;;) {
		try {
			fs.mkdirSync(lockDir)
			break
		} catch {
			if (Date.now() - start > LOCK_WAIT_MS) throw new Error(`lock held too long: ${lockDir}`)
			const age = Date.now() - (fs.statSync(lockDir, { throwIfNoEntry: false })?.mtimeMs ?? Date.now())
			if (age > LOCK_WAIT_MS) fs.rmSync(lockDir, { recursive: true, force: true })
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000)
		}
	}
	try {
		return work()
	} finally {
		fs.rmSync(lockDir, { recursive: true, force: true })
	}
}

const run = (command, cwd) => {
	const result = spawnSync(command, { cwd, stdio: 'inherit', shell: true })
	if (result.status !== 0) throw new Error(`${command} failed in ${cwd} (exit ${result.status})`)
}

// Installs and worktree removals are what refill the Windows file cache (an install writes ~170k files the antivirus
// reads), so each one ends by firing ram-clean.ps1 beside this file in the background. It runs the RAM clean scheduled
// task at most once per cooldown shared by every trigger, and does nothing when the task or the script is missing.
const ramClean = (reason) => {
	const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ram-clean.ps1')
	if (process.platform !== 'win32' || env.JSTACK_RAM_CLEAN_TASK === '' || !fs.existsSync(script)) return
	const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Reason', reason, '-SkipAbovePct', env.JSTACK_RAM_CLEAN_SKIP_ABOVE_PCT || '40']
	spawn('powershell', args, { cwd: path.dirname(script), detached: true, stdio: 'ignore', windowsHide: true }).unref()
}

const workspaceDirs = (root) => expandWorkspaces(workspacePatterns(fs.readFileSync(path.join(root, 'package.json'), 'utf8')), workingTreeReader(root).list)

const workspacePackages = (root) => {
	const map = new Map()
	for (const dir of workspaceDirs(root)) {
		const manifest = path.join(root, dir, 'package.json')
		if (fs.existsSync(manifest)) map.set(JSON.parse(fs.readFileSync(manifest, 'utf8')).name, path.join(root, dir))
	}
	return map
}

const nodeModulesDirs = (root) => ['node_modules', ...workspaceDirs(root).map((dir) => `${dir}/node_modules`)]

const isLinkedNodeModules = (dir) => fs.existsSync(path.join(dir, MARKER))

const removeLinkedTree = (dir) => {
	if (isLink(dir)) return fs.rmSync(dir, { force: true })
	if (!fs.existsSync(dir)) return
	for (const entry of fs.readdirSync(dir)) {
		const full = path.join(dir, entry)
		const stat = fs.lstatSync(full)
		if (stat.isDirectory() && !stat.isSymbolicLink()) removeLinkedTree(full)
		else fs.rmSync(full, { force: true })
	}
	fs.rmdirSync(dir)
}

const copyDepInputs = (from, to) => {
	for (const file of ['package.json', ...DEP_FILES]) if (fs.existsSync(path.join(from, file))) fs.copyFileSync(path.join(from, file), path.join(to, file))
	if (fs.existsSync(path.join(from, 'patches'))) fs.cpSync(path.join(from, 'patches'), path.join(to, 'patches'), { recursive: true })
	for (const dir of workspaceDirs(from)) {
		if (!fs.existsSync(path.join(from, dir, 'package.json'))) continue
		fs.mkdirSync(path.join(to, dir), { recursive: true })
		fs.copyFileSync(path.join(from, dir, 'package.json'), path.join(to, dir, 'package.json'))
	}
}

const adoptOwnInstall = (root, store) => {
	if (!fs.existsSync(path.join(root, 'node_modules')) || isLinkedNodeModules(path.join(root, 'node_modules'))) return false
	for (const dir of nodeModulesDirs(root)) {
		if (fs.existsSync(path.join(root, dir)) && fs.existsSync(path.dirname(path.join(store, dir)))) fs.renameSync(path.join(root, dir), path.join(store, dir))
	}
	console.log("worktree-deps: moved this worktree's own install into the store; the install only checks it against the lockfile")
	return true
}

const ensureDepsStore = (root, hash) => {
	const store = path.join(storesRoot(root), '.shared-deps', hash)
	const complete = path.join(store, '.complete')
	if (fs.existsSync(complete)) return store
	fs.mkdirSync(path.dirname(store), { recursive: true })
	return withLock(`${store}.lock`, () => {
		if (fs.existsSync(complete)) return store
		fs.rmSync(store, { recursive: true, force: true })
		fs.mkdirSync(store, { recursive: true })
		copyDepInputs(root, store)
		if (!adoptOwnInstall(root, store)) console.log(`worktree-deps: building shared store ${hash} (one install, reused by every worktree with these dependencies)`)
		run(CONFIG.storeInstall, store)
		fs.writeFileSync(complete, new Date().toISOString())
		ramClean('after store install')
		return store
	})
}

const scopedWorkspaces = (workspaces) => {
	const scopes = new Map()
	for (const [name, dir] of workspaces) {
		if (!name.startsWith('@')) continue
		const [scope, bare] = name.split('/')
		if (!scopes.has(scope)) scopes.set(scope, new Map())
		scopes.get(scope).set(bare, dir)
	}
	return scopes
}

const linkNodeModules = (source, dest, workspaces, marker) => {
	fs.mkdirSync(dest, { recursive: true })
	const scopes = scopedWorkspaces(workspaces)
	for (const entry of fs.readdirSync(source)) {
		const from = path.join(source, entry)
		const to = path.join(dest, entry)
		if (entry === MARKER) continue
		if (PER_TREE_ENTRIES.has(entry)) fs.mkdirSync(to, { recursive: true })
		else if (workspaces.has(entry)) junction(workspaces.get(entry), to)
		else if (scopes.has(entry)) {
			fs.mkdirSync(to)
			const own = scopes.get(entry)
			for (const sub of fs.readdirSync(from)) junction(own.get(sub) ?? path.join(from, sub), path.join(to, sub))
			for (const [sub, dir] of own) if (!exists(path.join(to, sub))) junction(dir, path.join(to, sub))
		} else if (fs.statSync(from).isDirectory()) junction(from, to)
		else fs.copyFileSync(from, to)
	}
	for (const [name, dir] of workspaces) if (!name.startsWith('@') && !exists(path.join(dest, name))) junction(dir, path.join(dest, name))
	for (const [scope, own] of scopes) {
		fs.mkdirSync(path.join(dest, scope), { recursive: true })
		for (const [sub, dir] of own) if (!exists(path.join(dest, scope, sub))) junction(dir, path.join(dest, scope, sub))
	}
	fs.writeFileSync(path.join(dest, MARKER), marker)
}

const linkDeps = (root, store, hash) => {
	const workspaces = workspacePackages(root)
	for (const dir of nodeModulesDirs(root)) {
		const dest = path.join(root, dir)
		removeLinkedTree(dest)
		if (fs.existsSync(path.join(store, dir))) linkNodeModules(path.join(store, dir), dest, dir === 'node_modules' ? workspaces : new Map(), `${hash}\n${store}\n`)
	}
}

const ownFile = (root) => path.join(git(root, 'rev-parse', '--absolute-git-dir').trim(), 'worktree-deps-own')
const ownedThings = (root) => (fs.existsSync(ownFile(root)) ? lines(fs.readFileSync(ownFile(root), 'utf8')) : [])
const setOwned = (root, thing, owned) => {
	const things = new Set(ownedThings(root))
	if (owned) things.add(thing)
	else things.delete(thing)
	fs.writeFileSync(ownFile(root), [...things].map((item) => `${item}\n`).join(''))
}

const ownDeps = (root) => {
	const linked = nodeModulesDirs(root).filter((dir) => isLinkedNodeModules(path.join(root, dir)))
	if (linked.length === 0 && fs.existsSync(path.join(root, 'node_modules'))) return console.log("worktree-deps: node_modules is already this worktree's own")
	for (const dir of linked) removeLinkedTree(path.join(root, dir))
	run(CONFIG.install, root)
	ramClean('after install')
	console.log("worktree-deps: node_modules is this worktree's own now (the shared store was not touched)")
}

const deps = (base) => {
	const root = worktreeRoot()
	if (ownedThings(root).includes('deps')) {
		console.log('worktree-deps: this worktree chose its own node_modules (worktree-deps share deps to link the store again)')
		return ownDeps(root)
	}
	if (samePath(root, mainCheckout(root))) {
		console.log('worktree-deps: the main checkout keeps its own install')
		run(CONFIG.install, root)
		return ramClean('after install')
	}
	const changed = changedDepFiles(root, base)
	if (changed.length > 0) {
		console.log(`worktree-deps: this branch changed its dependencies versus ${base} (${changed.join(', ')}): installing its own node_modules`)
		for (const dir of nodeModulesDirs(root)) if (isLinkedNodeModules(path.join(root, dir))) removeLinkedTree(path.join(root, dir))
		run(CONFIG.install, root)
		return ramClean('after install')
	}
	const hash = hashOf(depInputs(workingTreeReader(root), root))
	const store = ensureDepsStore(root, hash)
	if (fs.existsSync(path.join(root, 'node_modules')) && !isLinkedNodeModules(path.join(root, 'node_modules'))) {
		console.log("worktree-deps: deleting this worktree's own node_modules to link the shared store")
		for (const dir of nodeModulesDirs(root)) fs.rmSync(path.join(root, dir), { recursive: true, force: true })
	}
	linkDeps(root, store, hash)
	console.log(`worktree-deps: node_modules linked to shared store ${hash}`)
}

const codegenKey = (root) => {
	const parts = []
	for (const input of CONFIG.codegenInputs) {
		const tree = gitOrNull(root, 'rev-parse', `HEAD:${input}`)?.trim()
		if (!tree) return null
		if (spawnSync('git', ['-C', root, 'diff', '--quiet', 'HEAD', '--', input]).status !== 0) return null
		if (lines(gitOrNull(root, 'ls-files', '--others', '--exclude-standard', '--', input)).length > 0) return null
		parts.push(tree)
	}
	return hashOf(parts)
}

const stampFile = (root) => path.join(git(root, 'rev-parse', '--absolute-git-dir').trim(), 'worktree-deps-codegen-key')

const isCompleteGenerated = (root, dir) =>
	CONFIG.required.every((required) => {
		const target = path.join(dir, path.relative(CONFIG.generatedDir, required))
		if (!fs.existsSync(target)) return false
		return fs.statSync(target).isDirectory() ? fs.readdirSync(target).length > 0 : fs.statSync(target).size > 0
	})

const generatedMatches = (worktree, key) => {
	const dir = path.join(worktree, CONFIG.generatedDir)
	if (isLink(dir) || !fs.existsSync(dir) || !isCompleteGenerated(worktree, dir) || codegenKey(worktree) !== key) return false
	const stamp = fs.existsSync(stampFile(worktree)) ? fs.readFileSync(stampFile(worktree), 'utf8').trim() : null
	if (stamp) return stamp === key
	const lastInputChange = Number(gitOrNull(worktree, 'log', '-1', '--format=%ct', '--', ...CONFIG.codegenInputs)?.trim() || 0) * 1000
	return fs.statSync(dir).mtimeMs > lastInputChange
}

const ownGenerated = (root) => {
	const local = path.join(root, CONFIG.generatedDir)
	if (isLink(local)) {
		const source = fs.realpathSync(local)
		const copy = `${local}.own-${process.pid}`
		fs.cpSync(source, copy, { recursive: true })
		fs.rmSync(local, { force: true })
		fs.renameSync(copy, local)
		return console.log(`worktree-deps: ${CONFIG.generatedDir} is this worktree's own copy now (copied from the store, which was not touched)`)
	}
	if (!fs.existsSync(local) || !isCompleteGenerated(root, local)) run(CONFIG.codegen, root)
	console.log(`worktree-deps: ${CONFIG.generatedDir} is this worktree's own`)
}

const generated = () => {
	const root = worktreeRoot()
	if (!CONFIG.codegen) return console.log('worktree-deps: no codegen command configured')
	if (CONFIG.generatedDir && ownedThings(root).includes('generated')) {
		console.log(`worktree-deps: this worktree chose its own ${CONFIG.generatedDir} (worktree-deps share generated to link the store again)`)
		return ownGenerated(root)
	}
	if (!CONFIG.generatedDir || CONFIG.codegenInputs.length === 0) return run(CONFIG.codegen, root)
	const local = path.join(root, CONFIG.generatedDir)
	const key = codegenKey(root)
	if (!key || samePath(root, mainCheckout(root))) {
		detach(local)
		run(CONFIG.codegen, root)
		if (key) fs.writeFileSync(stampFile(root), key)
		return
	}
	const store = path.join(storesRoot(root), '.shared-generated', key)
	const complete = `${store}.complete`
	if (!fs.existsSync(complete)) {
		fs.mkdirSync(path.dirname(store), { recursive: true })
		withLock(`${store}.lock`, () => {
			if (fs.existsSync(complete)) return
			const seed = [root, ...worktreeList(root)].find((worktree) => generatedMatches(worktree, key))
			if (seed) console.log(`worktree-deps: seeding the shared ${CONFIG.generatedDir} from ${seed}`)
			else {
				detach(local)
				run(CONFIG.codegen, root)
			}
			fs.rmSync(store, { recursive: true, force: true })
			fs.cpSync(path.join(seed ?? root, CONFIG.generatedDir), store, { recursive: true })
			fs.writeFileSync(complete, new Date().toISOString())
		})
	}
	if (isLink(local)) fs.rmSync(local, { force: true })
	else fs.rmSync(local, { recursive: true, force: true })
	junction(store, local)
	console.log(`worktree-deps: ${CONFIG.generatedDir} linked to shared store ${key}`)
}

const detach = (target) => {
	const full = path.resolve(target)
	if (isLinkedNodeModules(full)) return removeLinkedTree(full)
	if (isLink(full)) {
		fs.rmSync(full, { force: true })
		fs.mkdirSync(full)
	}
}

const status = () => {
	const root = worktreeRoot()
	const nm = path.join(root, 'node_modules')
	const gen = CONFIG.generatedDir ? path.join(root, CONFIG.generatedDir) : null
	const nmState = isLinkedNodeModules(nm) ? `shared ${fs.readFileSync(path.join(nm, MARKER), 'utf8').split('\n')[0]}` : fs.existsSync(nm) ? 'own install' : 'missing'
	const genState = !gen ? 'not shared (no JSTACK_CODEGEN_REUSE_PATHS)' : isLink(gen) ? `shared ${path.basename(fs.realpathSync(gen))}` : fs.existsSync(gen) ? 'own' : 'missing'
	const owned = ownedThings(root)
	console.log(`own by choice: ${owned.length ? owned.join(', ') : 'nothing'}`)
	console.log(`node_modules: ${nmState} (wants ${hashOf(depInputs(workingTreeReader(root), root))})`)
	console.log(`${CONFIG.generatedDir ?? 'generated'}: ${genState} (wants ${codegenKey(root) ?? 'own: inputs edited'})`)
}

const prune = () => {
	const root = worktreeRoot()
	const used = new Set()
	for (const worktree of worktreeList(root)) {
		const marker = path.join(worktree, 'node_modules', MARKER)
		if (fs.existsSync(marker)) used.add(path.resolve(fs.readFileSync(marker, 'utf8').split('\n')[1]).toLowerCase())
		const gen = CONFIG.generatedDir ? path.join(worktree, CONFIG.generatedDir) : null
		if (gen && isLink(gen)) used.add(path.resolve(fs.realpathSync(gen)).toLowerCase())
	}
	for (const kind of ['.shared-deps', '.shared-generated']) {
		const dir = path.join(storesRoot(root), kind)
		if (!fs.existsSync(dir)) continue
		for (const entry of fs.readdirSync(dir)) {
			const store = path.join(dir, entry)
			if (/\.(lock|complete)$/.test(entry) || used.has(store.toLowerCase()) || fs.existsSync(`${store}.lock`)) continue
			console.log(`worktree-deps: deleting unused store ${kind}/${entry}`)
			fs.rmSync(`${store}.complete`, { force: true })
			fs.rmSync(store, { recursive: true, force: true })
		}
	}
}

const unlinkEveryLink = (dir) => {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name)
		if (isLink(full)) fs.rmSync(full, { force: true })
		else if (entry.isDirectory() && entry.name !== '.git') {
			if (entry.name === 'node_modules') {
				for (const top of fs.readdirSync(full, { withFileTypes: true })) {
					const topPath = path.join(full, top.name)
					if (isLink(topPath)) fs.rmSync(topPath, { force: true })
					else if (top.isDirectory() && top.name.startsWith('@'))
						for (const sub of fs.readdirSync(topPath)) if (isLink(path.join(topPath, sub))) fs.rmSync(path.join(topPath, sub), { force: true })
				}
			} else unlinkEveryLink(full)
		}
	}
}

const remove = (target, deleteBranch) => {
	const dir = path.resolve(target)
	if (samePath(dir, mainCheckout(dir))) throw new Error('refusing to remove the main checkout')
	const branch = gitOrNull(dir, 'symbolic-ref', '--quiet', '--short', 'HEAD')?.trim()
	const main = mainCheckout(dir)
	unlinkEveryLink(dir)
	if (spawnSync('git', ['-C', main, '-c', 'core.longpaths=true', 'worktree', 'remove', '--force', dir], { stdio: 'inherit' }).status !== 0) {
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
		spawnSync('git', ['-C', main, 'worktree', 'prune'], { stdio: 'inherit' })
	}
	if (deleteBranch && branch) spawnSync('git', ['-C', main, 'branch', '-D', branch], { stdio: 'inherit' })
	ramClean('after worktree remove')
	console.log(`worktree-deps: removed ${dir}${deleteBranch && branch ? ` and branch ${branch}` : ''} (links unlinked first, shared stores untouched)`)
}

const [command, ...rest] = process.argv.slice(2)
const baseIndex = rest.indexOf('--base')
const base = baseIndex >= 0 ? rest[baseIndex + 1] : CONFIG.base

if (command === 'deps') deps(base)
else if (command === 'generated') generated()
else if ((command === 'own' || command === 'share') && ['deps', 'generated'].includes(rest[0])) {
	setOwned(worktreeRoot(), rest[0], command === 'own')
	if (rest[0] === 'deps') deps(base)
	else generated()
} else if (command === 'detach' && rest[0]) detach(rest[0])
else if (command === 'status') status()
else if (command === 'prune') prune()
else if (command === 'remove' && rest[0]) remove(rest[0], rest.includes('--delete-branch'))
else if (command === 'plan') console.log(changedDepFiles(worktreeRoot(), base))
else {
	console.error('usage: node worktree-deps.mjs deps [--base <ref>] | generated | own <deps|generated> | share <deps|generated> | detach <path> | status | plan | prune | remove <worktree> [--delete-branch]')
	process.exit(2)
}
