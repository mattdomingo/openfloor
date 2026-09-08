import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Browser fixtures are produced by the same Git capture command as production.
export function conflictFixture(root) {
  const repository = join(root, 'conflict-repository'); mkdirSync(repository);
  const directory = join(root, 'captured-conflict');
  const environment = { ...process.env, GIT_AUTHOR_NAME: 'Browser fixture', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Browser fixture', GIT_COMMITTER_EMAIL: 'test@example.com' };
  const git = (...args) => execFileSync('git', args, { cwd: repository, env: environment, stdio: 'pipe' });
  git('init', '-q', '-b', 'candidate'); git('config', 'core.autocrlf', 'false'); mkdirSync(join(repository, 'src'));
  const path = join(repository, 'src', 'agent-change.ts');
  writeFileSync(path, 'export const feature = "base";\n// untouched tail\n'); git('add', '.'); git('commit', '-qm', 'base'); git('branch', 'openfloor-source-base');
  git('checkout', '-qb', 'incoming'); writeFileSync(path, 'export const feature = "incoming";\n// untouched tail\n'); git('commit', '-qam', 'incoming'); git('branch', 'openfloor-source-result');
  git('checkout', 'candidate'); writeFileSync(path, 'export const feature = "candidate";\n// untouched tail\n'); git('commit', '-qam', 'candidate');
  spawnSync('git', ['merge', '--no-commit', 'incoming'], { cwd: repository, env: environment });
  execFileSync(process.execPath, ['--experimental-strip-types', resolve('lib/conflict-workspace.ts'), 'capture', repository, directory], { stdio: 'pipe' });
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  return { manifest, files: manifest.files.map((file) => JSON.parse(readFileSync(join(directory, file.file), 'utf8'))) };
}
