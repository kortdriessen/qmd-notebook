/**
 * Real-kernel tests for the execution layer (no VS Code). Requires a Python with ipykernel,
 * pandas and matplotlib: set QMD_TEST_PYTHON or have ~/qmd-test-env/bin/python.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { KernelSession, type KernelEvent } from '../../src/execution/session';
import { OutputAccumulator, STDERR_MIME, STDOUT_MIME, ERROR_MIME, type OutputItem, type OutputRecord, type OutputSink } from '../../src/execution/outputModel';
import { extractJson, listVariablesCode, summarizeVariableCode } from '../../src/execution/variableInspector';

const PY = process.env.QMD_TEST_PYTHON ?? path.join(os.homedir(), 'qmd-test-env', 'bin', 'python');
const HOST = path.resolve(__dirname, '../../../../python/qmd_kernel_host.py');
const available = fs.existsSync(PY) && fs.existsSync(HOST);

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (m: string) => console.warn(m),
  error: (m: string) => console.error(m),
};

class MemorySink implements OutputSink {
  outputs: OutputRecord[] = [];
  clears = 0;
  append(o: OutputRecord): void {
    this.outputs.push(o);
  }
  appendItems(_o: OutputRecord, _items: OutputItem[]): void {
    /* record already mutated by accumulator */
  }
  replaceItems(_o: OutputRecord, _items: OutputItem[]): void {
    /* record already mutated */
  }
  clear(): void {
    this.clears++;
    this.outputs = [];
  }
}

function makeSession(): KernelSession {
  return new KernelSession(
    {
      hostPython: PY,
      hostScript: HOST,
      argv: [PY, '-m', 'ipykernel_launcher', '-f', '{connection_file}'],
      displayName: 'test kernel',
      cwd: os.tmpdir(),
    },
    logger,
  );
}

async function run(session: KernelSession, code: string, opts: { kind?: 'cell' | 'scratch'; timeoutMs?: number; onInput?: (prompt: string) => string } = {}) {
  const sink = new MemorySink();
  const acc = new OutputAccumulator(sink);
  const outcome = await session.execute({ code, kind: opts.kind ?? 'cell', timeoutMs: opts.timeoutMs, allowStdin: !!opts.onInput }, (ev: KernelEvent) => {
    if (ev.type === 'iopub') acc.handle(ev.msg);
    if (ev.type === 'input_request') ev.reply(opts.onInput ? opts.onInput(ev.prompt) : '');
  });
  const text = (mime: string) =>
    sink.outputs
      .flatMap((o) => o.items)
      .filter((i) => i.mime === mime)
      .map((i) => Buffer.from(i.data).toString('utf8'))
      .join('');
  return { outcome, sink, acc, text, mimes: sink.outputs.map((o) => o.items.map((i) => i.mime)) };
}

test('execution layer against a real kernel', { skip: !available && `no test python at ${PY}` }, async (t) => {
  const session = makeSession();
  t.after(async () => {
    await session.dispose();
  });

  await t.test('variables persist across cells and execution counts increase', { timeout: 30000 }, async () => {
    const a = await run(session, 'x = 41');
    assert.equal(a.outcome.success, true);
    assert.equal(a.acc.executionCount, 1);
    const b = await run(session, 'x + 1');
    assert.equal(b.text('text/plain'), '42');
    assert.equal(b.acc.executionCount, 2);
    assert.equal(session.status, 'idle');
  });

  await t.test('stdout and stderr keep their identity and order', { timeout: 30000 }, async () => {
    const r = await run(session, 'import sys\nprint("out1")\nprint("err1", file=sys.stderr)\nprint("out2")');
    assert.equal(r.text(STDOUT_MIME), 'out1\nout2\n');
    assert.equal(r.text(STDERR_MIME), 'err1\n');
    assert.ok(r.sink.outputs.every((o) => o.kind === 'stream'));
  });

  await t.test('pandas dataframe renders as text/html and matplotlib as image/png', { timeout: 30000 }, async () => {
    const r = await run(
      session,
      'import pandas as pd, matplotlib\nmatplotlib.use("module://matplotlib_inline.backend_inline")\nimport matplotlib.pyplot as plt\nplt.plot([1, 2, 3]); plt.show()\npd.DataFrame({"a": [1, 2], "b": ["x", "y"]})',
    );
    assert.equal(r.outcome.success, true, JSON.stringify(r.outcome.reply));
    const flat = r.sink.outputs.map((o) => ({ kind: o.kind, mimes: o.items.map((i) => i.mime) }));
    const png = r.sink.outputs.find((o) => o.items.some((i) => i.mime === 'image/png'));
    assert.ok(png, `no png in ${JSON.stringify(flat)}`);
    const pngItem = png!.items.find((i) => i.mime === 'image/png')!;
    assert.deepEqual(Array.from(pngItem.data.slice(0, 4)), [0x89, 0x50, 0x4e, 0x47]);
    const html = r.sink.outputs.find((o) => o.kind === 'execute_result');
    assert.ok(html && html.items.some((i) => i.mime === 'text/html'), `no html in ${JSON.stringify(flat)}`);
    assert.ok(r.text('text/html').includes('<table'));
    assert.equal(html!.items[0]!.mime, 'text/html', 'html should be ordered before text/plain');
  });

  await t.test('svg output', { timeout: 30000 }, async () => {
    const r = await run(session, 'from IPython.display import SVG, display\ndisplay(SVG(\'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>\'))');
    assert.ok(r.text('image/svg+xml').includes('<svg'));
  });

  await t.test('application/json and multiple outputs from one cell', { timeout: 30000 }, async () => {
    const r = await run(session, 'from IPython.display import JSON, display\ndisplay(JSON({"k": 1}))\nprint("mid")\ndisplay({"a": 1})\n7');
    assert.ok(r.text('application/json').includes('"k"'));
    assert.equal(r.text('text/plain').includes('7'), true);
    assert.ok(r.sink.outputs.length >= 4);
  });

  await t.test('exception produces an error output with traceback and failing reply', { timeout: 30000 }, async () => {
    const r = await run(session, 'def f():\n    raise ValueError("boom")\nf()');
    assert.equal(r.outcome.success, false);
    assert.equal(r.outcome.reply.status, 'error');
    const err = r.sink.outputs.find((o) => o.kind === 'error');
    assert.ok(err);
    const payload = JSON.parse(Buffer.from(err!.items[0]!.data).toString('utf8'));
    assert.equal(err!.items[0]!.mime, ERROR_MIME);
    assert.equal(payload.name, 'ValueError');
    assert.equal(payload.message, 'boom');
    assert.ok(payload.stack.includes('boom'));
  });

  await t.test('display update by display_id replaces the earlier output in place', { timeout: 30000 }, async () => {
    const r = await run(session, 'from IPython.display import display\nh = display("first", display_id="qmd-test")\nh.update("second")\nprint("after")');
    const displays = r.sink.outputs.filter((o) => o.kind === 'display_data');
    assert.equal(displays.length, 1);
    assert.equal(Buffer.from(displays[0]!.items.find((i) => i.mime === 'text/plain')!.data).toString(), "'second'");
    assert.equal(r.sink.outputs.length, 2);
  });

  await t.test('clear_output with and without wait', { timeout: 30000 }, async () => {
    const r = await run(session, 'from IPython.display import clear_output\nprint("a")\nclear_output()\nprint("b")\nclear_output(wait=True)\nprint("c")');
    assert.equal(r.text(STDOUT_MIME), 'c\n');
    assert.equal(r.sink.clears, 2);
  });

  await t.test('stdin input() is answered through the input_request event', { timeout: 30000 }, async () => {
    const r = await run(session, 'name = input("who? ")\nprint("hi " + name)', { onInput: (p) => (p === 'who? ' ? 'bob' : '?') });
    assert.equal(r.text(STDOUT_MIME).trim().endsWith('hi bob'), true);
  });

  await t.test('interrupt stops a long-running cell', { timeout: 30000 }, async () => {
    const promise = run(session, 'import time\nfor i in range(100):\n    time.sleep(0.1)');
    await new Promise((res) => setTimeout(res, 500));
    await session.interrupt();
    const r = await promise;
    assert.equal(r.outcome.success, false);
    assert.equal(r.acc.lastError?.ename, 'KeyboardInterrupt');
    const after = await run(session, 'x');
    assert.equal(after.text('text/plain'), '41');
  });

  await t.test('interrupt drops queued cells but not the kernel', { timeout: 30000 }, async () => {
    const p1 = run(session, 'import time\ntime.sleep(5)');
    const p2 = run(session, 'queued = 1');
    await new Promise((res) => setTimeout(res, 300));
    await session.interrupt();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.outcome.success, false);
    assert.equal(r2.outcome.cancelled, true);
    const chk = await run(session, '"queued" in dir()');
    assert.equal(chk.text('text/plain'), 'False');
  });

  await t.test('scratch execution shares the kernel, runs in order, and does not bump the execution count', { timeout: 30000 }, async () => {
    const before = await run(session, 'counter = 10');
    const count = before.acc.executionCount!;
    const s = await run(session, 'counter += 1\nprint(counter)', { kind: 'scratch' });
    assert.equal(s.text(STDOUT_MIME), '11\n');
    const after = await run(session, 'counter');
    assert.equal(after.text('text/plain'), '11');
    assert.equal(after.acc.executionCount, count + 1);
  });

  await t.test('scratch execution timeout interrupts and reports timedOut', { timeout: 30000 }, async () => {
    const r = await run(session, 'import time\ntime.sleep(30)', { kind: 'scratch', timeoutMs: 800 });
    assert.equal(r.outcome.timedOut, true);
    assert.equal(r.outcome.success, false);
    const ok = await run(session, '1 + 1');
    assert.equal(ok.text('text/plain'), '2');
  });

  await t.test('list_variables and summarize_variable helpers', { timeout: 30000 }, async () => {
    await run(session, 'import numpy as np, pandas as pd\narr = np.arange(6.0).reshape(2, 3)\ndf = pd.DataFrame({"a": [1, 2, None], "b": list("xyz")})\nnote = "hello"');
    const lv = await run(session, listVariablesCode(100), { kind: 'scratch' });
    const parsed = extractJson(lv.text(STDOUT_MIME)) as { variables: Array<{ name: string; type: string; shape: number[] | null }> };
    const names = parsed.variables.map((v) => v.name);
    assert.ok(names.includes('arr') && names.includes('df') && names.includes('note') && names.includes('x'));
    assert.ok(!names.includes('np'), 'modules are skipped');
    assert.ok(!names.some((n) => n.startsWith('__qmd')), 'helpers cleaned up');
    const df = parsed.variables.find((v) => v.name === 'df')!;
    assert.match(df.type, /^pandas\..*DataFrame$/);
    assert.deepEqual(df.shape, [3, 2]);
    const sv = await run(session, summarizeVariableCode('df', 5, 2000), { kind: 'scratch' });
    const summary = extractJson(sv.text(STDOUT_MIME)) as any;
    assert.deepEqual(summary.columns, ['a', 'b']);
    assert.equal(summary.nulls.a, 1);
    assert.ok(summary.head.includes('xyz'.slice(0, 1)));
    const sa = extractJson((await run(session, summarizeVariableCode('arr', 5, 2000), { kind: 'scratch' })).text(STDOUT_MIME)) as any;
    assert.equal(sa.min, 0);
    assert.equal(sa.max, 5);
    const bad = extractJson((await run(session, summarizeVariableCode('nope', 5, 2000), { kind: 'scratch' })).text(STDOUT_MIME)) as any;
    assert.ok(bad.error.includes('NameError'));
    const leftovers = await run(session, 'sorted(k for k in globals() if k.startswith("__qmd"))');
    assert.equal(leftovers.text('text/plain'), '[]');
  });

  await t.test('restart loses state and reports status transitions', { timeout: 30000 }, async () => {
    const states: string[] = [];
    const off = session.onDidChangeStatus((s) => states.push(s));
    await session.restart();
    off();
    assert.ok(states.includes('restarting'));
    assert.equal(session.status, 'idle');
    const r = await run(session, 'x');
    assert.equal(r.outcome.success, false);
    assert.equal(r.acc.lastError?.ename, 'NameError');
    assert.equal(r.acc.executionCount, 1);
  });

  await t.test('kernel crash is detected and the session reports dead', { timeout: 30000 }, async () => {
    const dead = new Promise<void>((res) => {
      const off = session.onDidChangeStatus((s) => {
        if (s === 'dead') {
          off();
          res();
        }
      });
    });
    const r = await run(session, 'import os\nos._exit(1)');
    assert.equal(r.outcome.success, false);
    await dead;
    assert.equal(session.status, 'dead');
  });
});
