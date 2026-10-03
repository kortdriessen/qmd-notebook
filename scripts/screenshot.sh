#!/usr/bin/env bash
# Launch VS Code (X11 backend, private profile) with the demo notebook and capture a screenshot
# of the running QMD Notebook with the recommended appearance settings applied.
#   scripts/screenshot.sh [out.png]
set -euo pipefail
cd "$(dirname "$0")/../packages/vscode-extension"
OUT="${1:-$(pwd)/../../docs/screenshot-qmd-notebook.png}"
export QMD_TEST_PYTHON="${QMD_TEST_PYTHON:-$HOME/qmd-test-env/bin/python}"
export QMD_DEMO=1 QMD_DEMO_SECONDS="${QMD_DEMO_SECONDS:-30}" QMD_TEST_GREP='demo' QMD_VSCODE_X11=1
node out/vscode-extension/test/runVsCodeTests.js > /tmp/qmd-demo.log 2>&1 &
PID=$!
# wait for the window
for i in $(seq 1 90); do
  if xdotool search --name 'Visual Studio Code' >/dev/null 2>&1 || xdotool search --name 'demo.qmd' >/dev/null 2>&1; then break; fi
  sleep 1
done
sleep "${QMD_DEMO_WAIT:-22}"
WID=$(xdotool search --name 'demo.qmd' | head -1 || true)
if [ -n "$WID" ]; then
  timeout 5 xdotool windowactivate "$WID" 2>/dev/null || true
  timeout 5 xdotool windowsize "$WID" 1600 1000 2>/dev/null || true
  timeout 5 xdotool windowmove "$WID" 0 0 2>/dev/null || true
  sleep 3
  # per-window grab: under Wayland/Xwayland the X root framebuffer is black
  ffmpeg -loglevel error -y -f x11grab -window_id "$WID" -i :0 -frames:v 1 "$OUT"
else
  echo "no demo window found"; tail -5 /tmp/qmd-demo.log
fi
echo "screenshot: $OUT"
wait $PID || true
