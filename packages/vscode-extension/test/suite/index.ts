import * as fs from 'node:fs';
import * as path from 'node:path';
import Mocha from 'mocha';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', color: true, timeout: 180000, reporter: 'spec' });
  const dir = __dirname;
  const only = process.env.QMD_TEST_GREP;
  if (only) mocha.grep(only);
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.test.js'))
    .sort();
  for (const f of files) mocha.addFile(path.join(dir, f));
  return new Promise((resolve, reject) => {
    try {
      mocha.run((failures) => (failures > 0 ? reject(new Error(`${failures} test(s) failed`)) : resolve()));
    } catch (e) {
      reject(e);
    }
  });
}
