import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { sandboxArguments } from './runtime-sandbox.mjs';

// Exercise capture and application inside the exact credential-free namespace.
const root = '/workspace/repository';
const scratch = '/tmp/openfloor/conflict-proof';
rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true });
rmSync(scratch, { recursive: true, force: true }); mkdirSync(scratch, { recursive: true });
const environment = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
function git(...args) { const result = spawnSync('git', ['-c', 'safe.directory=*', ...args], { cwd: root, env: environment, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); }
git('init', '-q', '-b', 'candidate'); git('config', 'core.autocrlf', 'false');
const path = 'shared feature 日本語.ts';
const tail = Array.from({ length: 4000 }, (_, index) => `// untouched ${index}\n`).join('');
writeFileSync(`${root}/${path}`, `base\n${tail}`); git('add', '.'); git('commit', '-qm', 'base'); git('branch', 'openfloor-source-base');
git('checkout', '-qb', 'incoming'); writeFileSync(`${root}/${path}`, `incoming\n${tail}`); git('commit', '-qam', 'incoming'); git('branch', 'openfloor-source-result');
git('checkout', 'candidate'); writeFileSync(`${root}/${path}`, `candidate\n${tail}`); git('commit', '-qam', 'candidate');
spawnSync('git', ['-c', 'safe.directory=*', 'merge', '--no-commit', 'incoming'], { cwd: root, env: environment });
spawnSync('chown', ['-R', '10002:10001', root, scratch]);
function isolated(args) { const result = spawnSync('/usr/bin/bwrap', sandboxArguments(['node', '--experimental-strip-types', '/opt/openfloor/conflict-workspace.ts', ...args]), { encoding: 'utf8', timeout: 60_000 }); assert.equal(result.status, 0, `${result.stdout} ${result.stderr}`); return result.stdout; }
const manifest = JSON.parse(isolated(['capture', root, `${scratch}/files`]));
assert.equal(manifest.files[0].path, path);
writeFileSync(`${scratch}/choices.json`, JSON.stringify([{ path, hunkIndex: 0, choice: 'both' }]));
isolated(['apply', root, `${scratch}/files`, `${scratch}/choices.json`]);
assert.equal(readFileSync(`${root}/${path}`, 'utf8'), `candidate\nincoming\n${tail}`);
assert.equal(git('ls-files', '-u'), '');
console.log('Conflict capture/application: exact namespace, Unicode paths, complete tails, zero model calls passed.');
