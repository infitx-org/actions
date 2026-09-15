#!/usr/bin/env node
// Commit the rebuilt metrics baseline and history file onto the pull request
// head branch. Dependency-free, like the other actions in this repository.
//
// Expects the caller to have already produced the files (blong's `rush ci-report`
// rebuilds them from the base branch plus the current run). This action only
// decides whether pushing them is safe, then commits and pushes.
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';

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
    const {ignore = false} = options;
    try {
        // `stdio: 'ignore'` makes execFileSync return null, so normalise to ''.
        return execFileSync('git', args, {
            cwd: workspace,
            encoding: 'utf8',
            stdio: ignore ? 'ignore' : ['ignore', 'pipe', 'inherit'],
        }) ?? '';
    } catch (error) {
        if (ignore) return '';
        throw error;
    }
}

function gitOk(args) {
    try {
        execFileSync('git', args, {cwd: workspace, stdio: 'ignore'});
        return true;
    } catch {
        return false;
    }
}

/** Run git and return its captured stdout (empty string when it fails). */
function gitOutput(args) {
    try {
        const out = execFileSync('git', args, {
            cwd: workspace,
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

// Re-trigger guard: the workflow token does not re-trigger runs, but a PAT would.
const headSubject = gitOutput(['log', '-1', '--pretty=%s']);
if (headSubject.startsWith('chore(metrics)')) skip(`head commit is already a metrics commit ("${headSubject}")`);

const present = files.filter((file) => existsSync(`${workspace}/${file}`));
if (present.length === 0) skip(`none of ${files.join(', ')} were produced by this run`);

// --- Commit and push -----------------------------------------------------------
git(['config', 'user.email', 'actions@github.com']);
git(['config', 'user.name', 'github-actions']);
git(['add', '--', ...present]);
const staged = gitOutput(['diff', '--cached', '--name-only']);
if (staged === '') skip('the baseline files are already up to date');

git(['commit', '-q', '-m', message]);

const remote = `https://x-access-token:${token}@github.com/${process.env.GITHUB_REPOSITORY}.git`;
const push = () => gitOk(['push', '--quiet', remote, `HEAD:${headRef}`]);

if (!push()) {
    // Someone else pushed in the meantime: rebase once and retry.
    console.log('::warning::push rejected, rebasing once and retrying');
    git(['pull', '--rebase', '--quiet', remote, headRef], {ignore: true});
    if (!push()) skip('push was rejected twice (concurrent update on the branch)');
}

setOutput('committed', 'true');
setOutput('head-ref', headRef);
summary(`Committed ${staged.split('\n').join(', ')} onto \`${headRef}\` (${message}).`);
