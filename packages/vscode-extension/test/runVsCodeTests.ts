/**
 * Launches VS Code with the extension under development and runs the integration suites.
 * Uses the locally installed VS Code when available (VSCODE_EXE or /usr/share/code/code) so the
 * tests exercise the exact build the user runs; falls back to downloading a stable build.
 *
 * A private extensions dir is populated with symlinks to the user's Python + Pylance extensions
 * (needed for the Pylance spike) and nothing else.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../..');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');
  const root = path.join(os.tmpdir(), 'qmd-vscode-test');
  const userDataDir = path.join(root, 'user-data');
  const extensionsDir = path.join(root, 'extensions');
  const workspace = path.join(root, 'workspace');
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.rmSync(path.join(root, 'qmd-notebook.log'), { force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(extensionsDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });

  // Populate the workspace with fixtures and a helper module for go-to-definition.
  const fixtures = path.resolve(extensionDevelopmentPath, '../../fixtures/qmd');
  for (const f of fs.readdirSync(fixtures)) fs.copyFileSync(path.join(fixtures, f), path.join(workspace, f));
  fs.writeFileSync(path.join(workspace, 'helpers.py'), 'def load_hypnogram(path: str) -> list[dict]:\n    """Load a hypnogram (stub)."""\n    return []\n');
  const testPython = process.env.QMD_TEST_PYTHON ?? path.join(os.homedir(), 'qmd-test-env', 'bin', 'python');
  fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, '.vscode', 'settings.json'),
    JSON.stringify(
      {
        'qmdNotebook.execution.pythonCandidates': [testPython],
        'qmdNotebook.logging.level': 'debug',
        'python.defaultInterpreterPath': testPython,
        'python.analysis.diagnosticMode': 'openFilesOnly',
        'python.analysis.typeCheckingMode': 'basic',
        'security.workspace.trust.enabled': false,
        'workbench.startupEditor': 'none',
        'update.mode': 'none',
        'telemetry.telemetryLevel': 'off',
        'extensions.autoUpdate': false,
        'extensions.autoCheckUpdates': false,
      },
      null,
      2,
    ),
  );

  // Symlink Python + Pylance from the user's extensions.
  const userExt = path.join(os.homedir(), '.vscode', 'extensions');
  if (fs.existsSync(userExt)) {
    const wanted = ['ms-python.python-', 'ms-python.vscode-pylance-', 'ms-python.debugpy-', 'ms-python.vscode-python-envs-'];
    for (const entry of fs.readdirSync(userExt)) {
      if (!wanted.some((w) => entry.startsWith(w))) continue;
      const target = path.join(extensionsDir, entry);
      if (!fs.existsSync(target)) fs.symlinkSync(path.join(userExt, entry), target, 'dir');
    }
  }

  const localExe = process.env.VSCODE_EXE ?? '/usr/share/code/code';
  const vscodeExecutablePath = fs.existsSync(localExe) ? localExe : undefined;
  const launchArgs = [
    workspace,
    `--user-data-dir=${userDataDir}`,
    `--extensions-dir=${extensionsDir}`,
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-updates',
    '--no-sandbox',
    ...(process.env.QMD_VSCODE_X11 ? ['--ozone-platform=x11'] : []),
  ];
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs,
    extensionTestsEnv: { QMD_TEST_PYTHON: testPython, QMD_TEST_WORKSPACE: workspace, QMD_TEST_ROOT: root, QMD_LOG_FILE: path.join(root, 'qmd-notebook.log'), ...(process.env.QMD_TEST_GREP ? { QMD_TEST_GREP: process.env.QMD_TEST_GREP } : {}) },
  });
}

main().catch((e) => {
  console.error('integration tests failed:', e);
  process.exit(1);
});
