// Quick manual check of the execution layer against a real kernel (no VS Code).
// Usage: node scripts/debug-session.js [python]
const path = require('path');
const os = require('os');
const { KernelSession } = require(path.resolve(
  __dirname,
  '../packages/vscode-extension/out/vscode-extension/src/execution/session.js',
));
const PY = process.argv[2] || process.env.QMD_TEST_PYTHON || path.join(os.homedir(), 'qmd-test-env', 'bin', 'python');
const HOST = path.resolve(__dirname, '../packages/vscode-extension/python/qmd_kernel_host.py');
const log = (l) => (m) => console.log(`[${l}] ${m}`);
const logger = { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };

(async () => {
  const s = new KernelSession(
    {
      hostPython: PY,
      hostScript: HOST,
      argv: [PY, '-m', 'ipykernel_launcher', '-f', '{connection_file}'],
      displayName: 'debug',
      cwd: os.tmpdir(),
    },
    logger,
  );
  s.onDidChangeStatus((st) => console.log('STATUS', st));
  const t = setTimeout(() => {
    console.log('TIMEOUT waiting');
    process.exit(2);
  }, 30000);
  console.log('executing...');
  const o = await s.execute({ code: 'x = 41', kind: 'cell' }, (ev) =>
    console.log('EV', ev.type, ev.type === 'iopub' ? ev.msg.msg_type : ''),
  );
  console.log('OUTCOME', JSON.stringify(o));
  const o2 = await s.execute({ code: 'x + 1', kind: 'cell' }, (ev) =>
    console.log('EV', ev.type, ev.type === 'iopub' ? ev.msg.msg_type + ' ' + JSON.stringify(ev.msg.content.data || ev.msg.content.text || '') : ''),
  );
  console.log('OUTCOME2', JSON.stringify(o2));
  clearTimeout(t);
  await s.dispose();
  process.exit(0);
})().catch((e) => {
  console.error('ERR', e);
  process.exit(1);
});
