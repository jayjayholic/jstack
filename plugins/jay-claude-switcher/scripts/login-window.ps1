# Opens a second Claude Code in a new window with its own config folder, so /login there
# never touches the session you are working in.
#   powershell -ExecutionPolicy Bypass -File login-window.ps1 [-Dir <folder>]
param([string]$Dir = (Join-Path $HOME '.claude-login'))

New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$command = "`$env:CLAUDE_CONFIG_DIR = '$Dir'; Write-Host 'Login window. Config folder:' `$env:CLAUDE_CONFIG_DIR; claude"
Start-Process powershell -ArgumentList '-NoExit', '-Command', $command
Write-Host "Opened a Claude Code window with CLAUDE_CONFIG_DIR=$Dir. Run /login there."
