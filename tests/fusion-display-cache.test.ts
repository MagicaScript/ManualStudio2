import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('native display-axis cache reads both observed OGS line layouts and rejects stale or ambiguous references', async () => {
  await promisify(execFile)('python', ['tests/fusion_display_cache_test.py'], { windowsHide: true });
});
