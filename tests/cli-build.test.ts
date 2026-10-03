import { describe, test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Builds the CLI exactly as `npm run build:cli` does and runs the result,
// since the bundle is what `pageindex` on PATH executes.
describe('built CLI', () => {
  test('starts under Node with a single shebang', () => {
    // Inside the repo, so the bundle's external packages resolve as dist/ does.
    const outDir = mkdtempSync(join(import.meta.dir, '..', '.cli-build-'));
    try {
      const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'));
      const script = (pkg.scripts['build:cli'] as string).replace('dist/cli.js', join(outDir, 'cli.js'));
      const root = join(import.meta.dir, '..');
      const env = { ...process.env, PATH: `${join(root, 'node_modules', '.bin')}:${process.env.PATH}` };
      const build = Bun.spawnSync(['sh', '-c', script], { cwd: root, env });
      expect(build.exitCode).toBe(0);

      const bundle = readFileSync(join(outDir, 'cli.js'), 'utf8');
      expect(bundle.match(/^#!.*$/gm)?.length).toBe(1);

      const run = Bun.spawnSync(['node', join(outDir, 'cli.js'), '--help'], { cwd: join(import.meta.dir, '..') });
      expect(run.stderr.toString()).not.toContain('SyntaxError');
      expect(run.exitCode).toBe(0);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 60_000);
});
