// The generated runtime pack is tracked; raw game installs stay local.
import { execFileSync } from 'node:child_process';

const forbiddenExtensions = ['.drs', '.slp', '.dat', '.wav', '.mid', '.exe', '.dll'];
const forbiddenDir = 'assets-local/';
const packDir = 'assets-local/pack/';

// `git ls-files` lists the index, so staged additions count as tracked.
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 })
  .split('\0')
  .filter(Boolean);

const offenders = files.filter((file) => {
  const lower = file.toLowerCase();
  if (lower.startsWith(packDir)) return false;
  return lower.startsWith(forbiddenDir) || forbiddenExtensions.some((ext) => lower.endsWith(ext));
});

if (offenders.length > 0) {
  console.error('tracked-file guard: raw game files must not be tracked or staged:');
  for (const file of offenders) console.error(`  ${file}`);
  console.error('Keep them in assets-local/ (gitignored) or AOE1_DIR, and `git rm --cached` them.');
  process.exit(1);
}
console.log(`tracked-file guard: ok (${files.length} tracked files checked)`);
