# What counts as evidence

Every artifact is recorded by `tools/unslop/evidence.mjs`, which writes `<run>/evidence/<id>.log` (output, secrets redacted and counted) and `<id>.evidence.json` (command, exit, assertion line, commit, dirty flag, machine state, duration, reruns). The ledger accepts CONFIRMED only when a rerun by a different agent reproduced it, and VERIFIED only when the re-test passes.

| Kind | Valid when | Rejected when |
|---|---|---|
| `failing-test` | a test fails on HEAD with an assertion that names the defect, and passes on the fix | it fails on import or setup; it asserts on a mock's own behaviour; it is flaky (fails fewer than 3 of 3 reruns) |
| `measurement` | over its budget by more than the A/A noise; n >= 10 interleaved where noise exists; validity preconditions logged (free RAM, quiet CPU, built artifact, headed GPU when it matters) | dev server; n = 1; no budget; a starved machine; headless GPU timings |
| `repro-script` | a script plus its raw output shows the wrong behaviour from a real entry point | the output was edited or summarised; it needs credentials the run does not hold |
| `static-proof` | the defect is a property of the text and needs no run: conflict marker, edited applied migration, secret in the diff, missing catalog key, duplicate migration stamp | anything whose harm depends on runtime behaviour |
| `render` | a screenshot or DOM measurement of the built app with URL, commit, time, theme and viewport recorded; axe output or measured boxes | stale (older than the last source change); a stubbed server response; no record of where it came from |

For a `static-proof`, the "command" is the check itself (for example `node {{JSTACK_TOOLS}}/unslop/scan.mjs --rule <id> --base <base> --fail-on-find`), so the skeptic can rerun it like any other.

A prompt-cache claim is a `measurement` over usage records or a `repro-script` replay, both through `cache-probe.mjs` (CONFIRM.md, "Prompt-cache findings"); a code reading alone is never evidence for it.

A measurement records its number with `--budget <n> --value-regex "<regex with one group>"`; the rerun reproduces when the value is still over the budget.

Never store raw user data, tokens or full payloads in evidence. If the output needs them to make sense, summarise the shape and keep the counts.
