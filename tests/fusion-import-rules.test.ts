import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('native import includes hidden entities and unchanged complete versions are no-ops', async () => {
  await promisify(execFile)('python', ['tests/fusion_import_rules_test.py'], { windowsHide: true });
});
