#!/usr/bin/env bash
# Full verification: unit tests (parser/emitter, shared, mcp), real-kernel tests, and the VS Code
# integration suites (launches the locally installed VS Code with a private profile).
#
#   QMD_TEST_PYTHON=/path/to/python scripts/smoke-test.sh        # python must have ipykernel, pandas, matplotlib
set -euo pipefail
cd "$(dirname "$0")/.."
export QMD_TEST_PYTHON="${QMD_TEST_PYTHON:-$HOME/qmd-test-env/bin/python}"
echo "== build"
npm run build
echo "== shared unit tests"
npm test -w packages/shared
echo "== mcp companion unit tests"
npm test -w packages/mcp-server
echo "== parser/emitter unit tests"
npm test -w packages/vscode-extension
echo "== real-kernel execution tests ($QMD_TEST_PYTHON)"
(cd packages/vscode-extension && node out/vscode-extension/test/kernel/session.test.js | tail -12)
echo "== VS Code integration tests"
npm run test:vscode -w packages/vscode-extension
