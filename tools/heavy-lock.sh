#!/usr/bin/env bash
# One machine-wide slot for HEAVY jobs: `next build`, full typechecks and `git push` (the pre-push hook typechecks).
# Usage: source /c/dev/hakutaku/heavy-lock.sh; heavy_acquire <name>; <heavy command>; heavy_release
# Before starting a server (`next start`): server_wait [min_free_gb] (waits for a free slot and enough RAM).
# Tests, installs and browser checks run without the slot. heavy_acquire also caps the JS heap at 4 GB (NODE_OPTIONS);
# Turbopack ignores that cap, which is why only one heavy job runs at a time.
HEAVY_SLOTS=(/c/dev/hakutaku/.heavy-lock)
# A slot counts as abandoned only after 45 min (a train build can take >15 min). The owner file can vanish between
# the test and the stat while another holder releases the slot, so a failed stat means "not stale".
_stale() {
  local mtime
  mtime=$(stat -c %Y "$1/owner" 2>/dev/null) || return 1
  [ -n "$mtime" ] && [ $(( $(date +%s) - mtime )) -gt 2700 ]
}
heavy_acquire() {
  while :; do
    for slot in "${HEAVY_SLOTS[@]}"; do
      _stale "$slot" && rm -rf "$slot"
      if mkdir "$slot" 2>/dev/null; then echo "$1 $(date)" > "$slot/owner"; export HEAVY_SLOT="$slot"; export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=4096"; return 0; fi
    done
    sleep 10
  done
}
heavy_release() {
  if [ -n "$HEAVY_SLOT" ]; then rm -rf "$HEAVY_SLOT"; unset HEAVY_SLOT; return 0; fi
  for slot in "${HEAVY_SLOTS[@]}"; do
    [ -n "$1" ] && [ -f "$slot/owner" ] && [ "$(cut -d' ' -f1 "$slot/owner")" = "$1" ] && rm -rf "$slot"
  done
}
browser_acquire() { :; }
browser_release() { :; }

# Waits until no heavy job holds the slot and enough RAM is free, before starting a server (next start).
# Usage: source /c/dev/hakutaku/heavy-lock.sh; server_wait [min_free_gb]
server_wait() {
	local need="${1:-8}"
	while :; do
		local held=0; for s in "${HEAVY_SLOTS[@]}"; do [ -d "$s" ] && held=1; done
		local free_gb; free_gb=$(powershell -NoProfile -Command "[math]::Floor((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB)" 2>/dev/null | tr -d '\r')
		if [ "$held" = 0 ] && [ "${free_gb:-0}" -ge "$need" ]; then return 0; fi
		sleep 30
	done
}
