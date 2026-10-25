// node --test tools/memory/symbols.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { symbolsOf, enclosingSymbol, findSymbol, normalize, bodyHash, fingerprints, jaccard } from './symbols.mjs'

const names = (text, file) => symbolsOf(text, file).map(s => `${s.qname}:${s.start}-${s.end}`)

test('TS/JS: functions, classes, methods and arrows with their ranges', () => {
  const ts = [
    'export async function syncBatch(items: Item[]): Promise<void> {',
    '  for (const i of items) await send(i)',
    '}',
    'class Worker {',
    '  private async run(job: Job): Promise<void> {',
    '    return go(job)',
    '  }',
    '}',
    'export const add = (a, b) => a + b',
    'const later = async (x) => {',
    '  return x',
    '}',
  ].join('\n')
  assert.deepEqual(names(ts, 'a.ts'), ['syncBatch:1-3', 'Worker:4-8', 'Worker.run:5-7', 'add:9-9', 'later:10-12'])
})

test('Python ranges follow indentation and include decorators', () => {
  const py = '@cache\ndef load(x):\n    return x\n\nclass Repo:\n    def get(self, k):\n        return k\n\nTOP = 1\n'
  assert.deepEqual(names(py, 'a.py'), ['load:1-3', 'Repo:5-7', 'Repo.get:6-7'])
})

test('Go and Rust definitions', () => {
  const go = 'package x\n\nfunc (s *Svc) Run(a int) error {\n\treturn nil\n}\n\ntype Svc struct {\n\tA int\n}\n'
  assert.deepEqual(names(go, 'a.go'), ['Run:3-5', 'Svc:7-9'])
  const rs = 'impl Foo {\n    pub fn bar(&self) -> u8 {\n        1\n    }\n}\nfn main() {\n}\n'
  assert.deepEqual(names(rs, 'a.rs'), ['Foo:1-5', 'Foo.bar:2-4', 'main:6-7'])
})

test('negative: braces inside strings and comments do not end a body early', () => {
  const ts = 'function a() {\n  const s = "}"\n  // }\n  /* } */\n  const t = `}`\n  return s\n}\nfunction b() {}\n'
  assert.deepEqual(names(ts, 'a.ts'), ['a:1-7', 'b:8-8'])
  const rs = "fn lifetimes<'a>(x: &'a str) -> char {\n    '}'\n}\n"
  assert.deepEqual(names(rs, 'a.rs'), ['lifetimes:1-3'])
})

test('negative: calls and control flow are not definitions; nested functions are found innermost', () => {
  const ts = 'function outer() {\n  doThing(x)\n  if (a) {\n    b()\n  }\n  function inner() {\n    return 1\n  }\n}\n'
  assert.deepEqual(names(ts, 'a.ts'), ['outer:1-9', 'inner:6-8'])
  assert.equal(enclosingSymbol(ts, 'a.ts', 7).name, 'inner')
  assert.equal(enclosingSymbol(ts, 'a.ts', 2).name, 'outer')
  assert.equal(findSymbol(ts, 'a.ts', 'inner').start, 6)
})

test('normalization survives formatting-only changes and not real changes', () => {
  const a = 'function f ( x ) {\n  return [1, 2,];  // note\n}'
  const b = 'function f(x){return [1,2]}'
  assert.equal(bodyHash(a, 'ts'), bodyHash(b, 'ts'))
  assert.notEqual(bodyHash(a, 'ts'), bodyHash('function f(x){return [1,3]}', 'ts'))
  assert.equal(normalize('x = 1  # c', 'py'), 'x=1')
})

test('fingerprints: same body high similarity, unrelated body low', () => {
  const body = 'function syncBatch(items) { for (const i of items) { const r = await provider.send(i); if (!r.ok) throw new Error("x"); mark(i) } }'
  const renamed = body.replace('syncBatch', 'commitBatch')
  const other = 'function render(props) { return <div className="card">{props.title}</div> }'
  assert.ok(jaccard(fingerprints(body, 'ts'), fingerprints(renamed, 'ts')) >= 0.6)
  assert.ok(jaccard(fingerprints(body, 'ts'), fingerprints(other, 'ts')) < 0.2)
})
