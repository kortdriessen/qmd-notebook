#!/usr/bin/env bash
# Install the packaged VSIX into a private VS Code profile (with the user's Python + Pylance
# extensions symlinked in), open a realistic .qmd directly as a QMD Notebook with the recommended
# appearance settings, capture a screenshot, and check the extension log for activation.
#   scripts/vsix-smoke.sh [out.png]
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-$(pwd)/docs/screenshot-packaged-vsix.png}"
ROOT=/tmp/qmd-vsix-test
CODE_BIN="${VSCODE_EXE:-/usr/share/code/code}"
PY="${QMD_TEST_PYTHON:-$HOME/qmd-test-env/bin/python}"
rm -rf "$ROOT"; mkdir -p "$ROOT/extensions" "$ROOT/user-data" "$ROOT/workspace/.vscode"
for e in ms-python.python- ms-python.vscode-pylance- ms-python.debugpy- ms-python.vscode-python-envs-; do
  for d in "$HOME"/.vscode/extensions/$e*; do [ -d "$d" ] && ln -s "$d" "$ROOT/extensions/$(basename "$d")"; done
done
# Unpack the VSIX exactly as VS Code would lay it out (the `code --install-extension` CLI needs a
# display session and hangs in headless RDP sessions).
VER=$(python3 -c "import json;print(json.load(open('packages/vscode-extension/package.json'))['version'])")
mkdir -p "$ROOT/unpack" && unzip -q -o qmd-notebook.vsix -d "$ROOT/unpack" && mv "$ROOT/unpack/extension" "$ROOT/extensions/kortdriessen.qmd-notebook-$VER"
echo "installed from VSIX:"; ls "$ROOT/extensions/kortdriessen.qmd-notebook-$VER" 
cp fixtures/qmd/realistic-analysis.qmd "$ROOT/workspace/analysis.qmd"
cat > "$ROOT/workspace/.vscode/settings.json" <<EOF
{
  "workbench.editorAssociations": { "*.qmd": "qmd-notebook" },
  "workbench.startupEditor": "none",
  "workbench.colorTheme": "Default Dark Modern",
  "security.workspace.trust.enabled": false,
  "qmdNotebook.execution.pythonCandidates": ["$PY"],
  "qmdNotebook.logging.level": "debug",
  "qmdNotebook.logging.file": "$ROOT/qmd-notebook.log",
  "notebook.cellFocusIndicator": "border",
  "notebook.cellToolbarLocation": { "default": "right", "qmd-notebook": "right" },
  "notebook.consolidatedRunButton": true,
  "notebook.showCellStatusBar": "visible",
  "notebook.insertToolbarLocation": "hidden",
  "notebook.compactView": true,
  "notebook.lineNumbers": "off",
  "notebook.output.scrolling": true,
  "workbench.colorCustomizations": {
    "notebook.cellBorderColor": "#80808048",
    "notebook.focusedCellBorder": "#3794ffcc",
    "notebook.inactiveFocusedCellBorder": "#80808080",
    "notebook.selectedCellBorder": "#80808080",
    "notebook.inactiveSelectedCellBorder": "#80808060",
    "notebook.cellEditorBackground": "#80808014",
    "notebook.focusedCellBackground": "#80808010",
    "notebook.selectedCellBackground": "#8080800c",
    "notebook.outputContainerBackgroundColor": "#8080800a",
    "notebook.outputContainerBorderColor": "#80808030",
    "notebook.focusedEditorBorder": "#3794ff66"
  }
}
EOF
"$CODE_BIN" --ozone-platform=x11 --user-data-dir "$ROOT/user-data" --extensions-dir "$ROOT/extensions" \
  --disable-workspace-trust --skip-welcome --skip-release-notes --disable-updates --no-sandbox \
  "$ROOT/workspace" "$ROOT/workspace/analysis.qmd" > "$ROOT/launch.log" 2>&1 &
PID=$!
WID=""
for i in $(seq 1 60); do
  WID=$(xdotool search --name 'analysis.qmd' 2>/dev/null | head -1 || true)
  [ -n "$WID" ] && break
  sleep 1
done
sleep "${QMD_SMOKE_WAIT:-15}"
if [ -n "$WID" ]; then
  timeout 5 xdotool windowactivate "$WID" 2>/dev/null || true
  timeout 5 xdotool windowsize "$WID" 1500 950 2>/dev/null || true
  timeout 5 xdotool windowmove "$WID" 0 0 2>/dev/null || true
  sleep 3
  eval "$(timeout 5 xdotool getwindowgeometry --shell "$WID")"
  ffmpeg -loglevel error -y -f x11grab -window_id "$WID" -i :0 -frames:v 1 "$OUT" || ffmpeg -loglevel error -y -f x11grab -video_size "${WIDTH}x${HEIGHT}" -i ":0+${X},${Y}" -frames:v 1 "$OUT"
  echo "screenshot: $OUT (${WIDTH}x${HEIGHT})"
else
  echo "no VS Code window found; log:"; tail -20 "$ROOT/launch.log"
fi
echo "--- extension log ---"; cat "$ROOT/qmd-notebook.log" 2>/dev/null | head -20
kill $PID 2>/dev/null || true
sleep 2
# kill the private VS Code instance (bracket trick avoids matching this script's own command line)
pkill -f "qmd-vsix-[t]est/user-data" 2>/dev/null || true
