#!/usr/bin/env node
// Commit the rebuilt metrics baseline and history file onto the pull request
// head branch. Dependency-free, like the other actions in this repository.
//
// Expects the caller to have already produced the files (blong's `rush ci-report`
// rebuilds them from the base branch plus the current run). This action only
// decides whether pushing them is safe, then commits and pushes.
//
// The commit is made in a scratch clone of the branch tip, never in the CI
// checkout. By the time a test run finishes that checkout is a stale merge
// commit of the whole repository, and pushing it races with whatever advanced
// the branch meanwhile — which on a `release-please--*` branch is routine (the
// bot pushes whenever main moves), so "push rejected, rebasing once" was the
// expected outcome rather than the exception. Cloning the tip seconds before
// pushing keeps the push a plain fast-forward whose only new content is these
// two files, whatever else happened to the branch during the run.
import {copyFileSync, existsSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
const token = (process.env.INPUT_TOKEN || '').trim();
const message = (process.env.INPUT_MESSAGE || 'chore(metrics): update baseline').trim();
const files = [process.env.INPUT_METRICS_FILE || '.github/metrics.json', process.env.INPUT_HISTORY_FILE || '.github/history.jsonl']
    .map((file) => file.trim())
    .filter(Boolean);

function setOutput(name, value) {
    const file = process.env.GITHUB_OUTPUT;
    if (file) writeFileSync(file, `${name}=${value}\n`, {flag: 'a'});
}

function summary(markdown) {
    const file = process.env.GITHUB_STEP_SUMMARY;
    if (file) writeFileSync(file, markdown + '\n', {flag: 'a'});
    console.log(markdown);
}

function skip(reason) {
    setOutput('committed', 'false');
    setOutput('head-ref', '');
    summary(`Metrics/history not committed: ${reason}`);
    process.exit(0);
}

function git(args, options = {}) {
    const {ignore = false, cwd = workspace} = options;
    try {
        // `stdio: 'ignore'` makes execFileSync return null, so normalise to ''.
        return execFileSync('git', args, {
            cwd,
            encoding: 'utf8',
            stdio: ignore ? 'ignore' : ['ignore', 'pipe', 'inherit'],
        }) ?? '';
    } catch (error) {
        if (ignore) return '';
        throw error;
    }
}

function gitOk(args, cwd = workspace) {
    try {
        execFileSync('git', args, {cwd, stdio: 'ignore'});
        return true;
    } catch {
        return false;
    }
}

/** Run git and return its captured stdout (empty string when it fails). */
function gitOutput(args, cwd = workspace) {
    try {
        const out = execFileSync('git', args, {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        return (out ?? '').trim();
    } catch {
        return '';
    }
}

// --- Decide whether this run may push ------------------------------------------
let event = {};
try {
    event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
} catch {
    // No payload (local dry run): behave like a non-PR event.
}

const pr = event.pull_request;
if (!pr) skip('not a pull_request event');
if (pr.head?.repo?.fork || (pr.head?.repo?.full_name && pr.head.repo.full_name !== event.repository?.full_name)) {
    skip('pull request comes from a fork (token is read-only)');
}
if (!token) skip('no token with contents:write available');

const headRef = pr.head?.ref;
if (!headRef) skip('pull request has no head ref');

const present = files.filter((file) => existsSync(join(workspace, file)));
if (present.length === 0) skip(`none of ${files.join(', ')} were produced by this run`);

// --- Prepare a clone sitting on the branch tip ----------------------------------
const scratch = join(process.env.RUNNER_TEMP || tmpdir(), 'metrics-commit');
const remote = `https://x-access-token:${token}@github.com/${process.env.GITHUB_REPOSITORY}.git`;

/** Clone (or re-clone) the pull request branch tip into the scratch directory. */
function clone() {
    rmSync(scratch, {recursive: true, force: true});
    git(['clone', '--quiet', '--depth=1', '--single-branch', '--branch', headRef, remote, scratch]);
    git(['config', 'user.email', 'actions@github.com'], {cwd: scratch});
    git(['config', 'user.name', 'github-actions'], {cwd: scratch});
}

/** Copy this run's baseline files in and stage them; returns the staged paths. */
function stage() {
    for (const file of present) copyFileSync(join(workspace, file), join(scratch, file));
    git(['add', '--', ...present], {cwd: scratch});
    return gitOutput(['diff', '--cached', '--name-only'], scratch);
}

let staged = '';
try {
    clone();
    // Re-trigger guard, read from the branch tip rather than from the stale
    // checkout: the workflow token does not re-trigger runs, but a PAT would.
    const tip = gitOutput(['log', '-1', '--pretty=%s'], scratch);
    if (tip.startsWith('chore(metrics)')) skip(`the branch tip is already a metrics commit ("${tip}")`);
    staged = stage();
} catch (error) {
    // A clone that cannot be made is an environment problem, not a test failure.
    skip(`could not prepare a clone of ${headRef} (${error?.message ?? error})`);
}
if (staged === '') skip('the baseline files are already up to date');

git(['commit', '-q', '-m', message], {cwd: scratch});

const push = () => gitOk(['push', '--quiet', 'origin', `HEAD:refs/heads/${headRef}`], scratch);

if (!push()) {
    // Someone advanced the branch between the clone and the push: take their
    // commit as the new base and replay ours once.
    console.log('::notice::push rejected — refetching the branch tip and retrying once');
    git(['fetch', '--quiet', '--depth=1', 'origin', headRef], {cwd: scratch, ignore: true});
    git(['reset', '--hard', 'FETCH_HEAD'], {cwd: scratch, ignore: true});
    staged = stage();
    if (staged === '') skip('the branch already carries this baseline');
    git(['commit', '-q', '-m', message], {cwd: scratch});
    if (!push()) skip('push was rejected twice (concurrent update on the branch)');
}

setOutput('committed', 'true');
setOutput('head-ref', headRef);
summary(`Committed ${staged.split('\n').join(', ')} onto \`${headRef}\` (${message}).`);
