import { mkdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { githubGitAuthorization } from './github-git-auth.mjs';

// Trusted, credential-bearing integration. Never run candidate code here.
const setting = (name) => {
  const value = process.env[`OPENFLOOR_${name}`];
  if (!value) throw new Error(`Missing integration setting: ${name}`);
  return value;
};
const root = setting('INTEGRATION_ROOT');
const token = setting('GITHUB_TOKEN');
const auth = githubGitAuthorization(token);
const candidateRef = `refs/heads/${setting('CANDIDATE_BRANCH')}`;
const runRef = `refs/heads/${setting('RUN_BRANCH')}`;
const sourceSha = setting('SOURCE_SHA');
const expectedSha = setting('CANDIDATE_SHA');
const runSha = setting('RUN_SHA');
const resolution = process.env.OPENFLOOR_RESOLUTION === 'true';
for (const sha of [sourceSha, expectedSha, runSha]) if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid integration SHA');
function git(args, allowFailure = false) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', '-c', `http.extraHeader=${auth}`, ...args], {
    cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: 'openfloor', GIT_AUTHOR_EMAIL: 'runtime@opnflr.com', GIT_COMMITTER_NAME: 'openfloor', GIT_COMMITTER_EMAIL: 'runtime@opnflr.com' }, maxBuffer: 30 * 1024 * 1024,
  });
  if (result.status !== 0 && !allowFailure) throw new Error(`Trusted integration failed (${args[0]}): ${String(result.stderr || result.error).replaceAll(token, '[REDACTED]').replaceAll(auth.slice('Authorization: Basic '.length), '[REDACTED]').slice(-1000)}`);
  return { ok: result.status === 0, text: result.stdout?.toString('utf8') ?? '' };
}
function changedPaths(from, to) {
  const fields = git(['diff', '--name-status', '-M', '-z', from, to]).text.split('\0').filter(Boolean);
  const paths = new Set();
  const renames = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++];
    const from = fields[i++]; paths.add(from);
    if (/^[RC]/.test(status)) { const to = fields[i++]; paths.add(to); renames.push([from, to]); }
  }
  if (paths.has(undefined)) throw new Error('Incomplete Git path inventory');
  return { paths, renames };
}
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
git(['init', '-q']);
git(['remote', 'add', 'origin', setting('REPOSITORY_URL')]);
git(['fetch', '--no-tags', 'origin', `${candidateRef}:refs/openfloor/candidate`, `${runRef}:refs/openfloor/run`]);
const observed = git(['rev-parse', 'refs/openfloor/candidate']).text.trim();
if (git(['rev-parse', 'refs/openfloor/run']).text.trim() !== runSha) throw new Error('Run branch changed before integration');
let result;
// Recovery after a successful push whose Workflow result was lost.
if (git(['merge-base', '--is-ancestor', runSha, observed], true).ok) {
  result = { status: 'integrated', candidateSha: observed };
} else if (observed !== expectedSha || resolution && sourceSha !== observed) {
  result = { status: 'moved', reason: 'Candidate changed. Refresh conflict versions before integrating.' };
} else {
  const incoming = changedPaths(sourceSha, runSha);
  const candidate = changedPaths(sourceSha, observed);
  const affected = new Set([...incoming.paths].filter((path) => candidate.paths.has(path)));
  const renames = [...incoming.renames, ...candidate.renames];
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const pair of renames) if (pair.some((path) => affected.has(path))) for (const path of pair) if (!affected.has(path)) { affected.add(path); expanded = true; }
  }
  const overlap = [...affected].sort();
  if (!resolution && overlap.length) {
    result = { status: 'conflicted', trigger: 'overlap', paths: overlap, reason: 'Both prompts changed overlapping files. Assess their intents before integration.' };
  } else {
    git(['checkout', '--detach', observed]);
    const merged = git(['merge', resolution ? '--ff-only' : '--no-edit', runSha], true);
    if (!merged.ok) {
      const paths = git(['diff', '--name-only', '--diff-filter=U', '-z']).text.split('\0').filter(Boolean);
      if (!paths.length) throw new Error('Git could not integrate the verified run');
      result = { status: 'conflicted', trigger: 'git', paths, reason: 'Git requires a decision for overlapping changes.' };
    } else {
      const next = git(['rev-parse', 'HEAD']).text.trim();
      git(['merge-base', '--is-ancestor', observed, next]);
      // The lease gives compare-and-set semantics; the ancestry check above
      // ensures this explicit lease can never authorize a history rewrite.
      const pushed = git(['push', `--force-with-lease=${candidateRef}:${observed}`, 'origin', `${next}:${candidateRef}`], true);
      if (!pushed.ok) throw new Error('Candidate update rejected. Retry to reconcile current branch state.');
      result = { status: 'integrated', candidateSha: next };
    }
  }
}
await writeFile(setting('RESULT_PATH'), JSON.stringify(result));
