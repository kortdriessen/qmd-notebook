#!/usr/bin/env bash
# Build everything and package the extension into qmd-notebook.vsix at the repo root.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build -w packages/shared
npm run build -w packages/mcp-server
npm run package -w packages/vscode-extension
ls -la qmd-notebook.vsix
