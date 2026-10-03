#!/usr/bin/env bash
# Install QMD Notebook from a GitHub Release (the latest, or the tag given as $1).
#   scripts/install-latest.sh            # latest release
#   scripts/install-latest.sh v0.2.0     # a specific release
# Needs the GitHub CLI (`gh auth login`) because the repository is private. Set CODE to use another
# VS Code CLI (e.g. CODE=code-insiders). In a Remote SSH terminal it installs on the remote host.
set -euo pipefail
repo="kortdriessen/qmd-notebook"
code_cli="${CODE:-code}"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
gh release download ${1:+"$1"} -R "$repo" -p 'qmd-notebook-*.vsix' -D "$tmp"
vsix=$(ls "$tmp"/qmd-notebook-*.vsix)
"$code_cli" --install-extension "$vsix" --force
echo "Installed $(basename "$vsix"). Reload VS Code windows, then run"
echo "'QMD Notebook: Configure Claude Code / Codex MCP Access' once on this machine."
