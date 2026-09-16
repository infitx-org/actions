#!/usr/bin/env node
// Publish the rebuilt metrics baseline and history file as a stacked pull request:
// push them to a `metrics/` branch of their own and open a pull request from there
// onto the pull request head branch.
//
// Committing them onto the head branch instead makes that commit the branch tip
// and, because such a commit has to be pushed with `[skip ci]`, leaves the tip
// showing checks that never run — hiding the checks of the commit that was really
// pushed. A release-please branch makes it worse, since the bot rewrites it
// whenever main moves. Stacking keeps the head branch's own commits as its tip, so
// its checks stay readable, and turns the two generated files into a normal,
// optional, reviewable change.
//
// Dependency-free, like the other actions in this repository.
//
// Expects the caller to have already produced the files (blong's `rush ci-report`
// rebuilds them from the base branch plus the current run). This action only
// decides whether publishing them is safe, then commits, pushes and opens the
// pull request.
//
// The commit is made in a scratch clone of the branch tip, never in the CI
// checkout. By the time a test run finishes that checkout is a stale merge
// commit of the whole repository, and pushing it races with whatever advanced
// the branch meanwhile — which on a `release-please--*` branch is routine. Cloning
// the tip seconds before pushing makes the stacked branch the current tip plus
// this one commit, whatever else happened during the run, and the force-push keeps
// it at exactly that: the pull request rebases itself onto a branch that moved
// instead of conflicting with it, and it cannot accumulate commits.
//
// Nothing carries `[skip ci]`. The push and the pull request are both made with the
// workflow token (normally the caller's `github.token`), and events raised by that
// token start no workflow run, so nothing has to be suppressed. A marker would be
// actively harmful: merging the stacked pull request puts the commit on the head
// branch, where it would suppress the run for the merged result. A PAT would start
// a run for the push and for the opened pull request, so do not pass one.
import {copyFileSync, existsSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
const token = (process.env.INPUT_TOKEN || '').trim();
const message = 'chore(metrics): update baseline';
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

// Branch the stacked commit lives on. A fixed name, so one pull request keeps one
// stacked pull request rather than a new one per push.
const stackedRef = `metrics/${headRef}`;
if (stackedRef === headRef || stackedRef === pr.base?.ref) {
    skip(`the stacked branch "${stackedRef}" collides with one of the pull request's own branches`);
}

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
    // No re-trigger guard: the head branch never receives a metrics commit, and
    // the stacked branch is rewritten to a single commit, so there is nothing to
    // accumulate.
    staged = stage();
} catch (error) {
    // A clone that cannot be made is an environment problem, not a test failure.
    skip(`could not prepare a clone of ${headRef} (${error?.message ?? error})`);
}
if (staged === '') skip('the baseline files are already up to date');

git(['commit', '-q', '-m', message], {cwd: scratch});

// Force-push: the stacked branch is always the head branch tip plus this single
// commit, so a run that follows a branch update replaces the previous stacked
// commit instead of adding another one.
const push = () => gitOk(['push', '--quiet', '--force', 'origin', `HEAD:refs/heads/${stackedRef}`], scratch);

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

// --- Publish the stacked pull request ------------------------------------------
const repository = process.env.GITHUB_REPOSITORY || '';
const server = (process.env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/$/, '');
const runUrl = `${server}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`;

/** Minimal REST call: the action stays dependency-free, so no octokit. */
async function api(path, init = {}) {
    const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
        ...init,
        headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/vnd.github+json',
            'content-type': 'application/json',
            'user-agent': 'commit-metrics',
            'x-github-api-version': '2022-11-28',
        },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${init.method || 'GET'} ${path} returned ${response.status}: ${text}`);
    return text ? JSON.parse(text) : undefined;
}

/**
 * Open, or refresh, the pull request carrying the stacked commit onto the head
 * branch. It is created with the same token as the push — the workflow token —
 * because `pull_request` events raised by that token start no workflow run, which
 * is the point here: a stacked pull request must not spend a full CI run on two
 * generated files.
 */
async function publishStackedPullRequest() {
    const owner = repository.split('/')[0];
    const base = pr.base?.ref ?? 'the base branch';
    const title = 'chore(metrics): update baseline';
    const body = [
        `Rebuilt \`.github/metrics.json\` and \`.github/history.jsonl\` from run [${process.env.GITHUB_RUN_NUMBER}](${runUrl}) — \`${base}\` plus that run's results.`,
        '',
        `They are stacked here instead of committed onto \`${headRef}\`, so that branch keeps the checks of its own commits: a metrics commit is skipped (\`[skip ci]\`) and would leave the branch tip waiting on checks that never run.`,
        '',
        `\`${stackedRef}\` is rewritten on every run — one commit, always the tip of \`${headRef}\` plus these two files — so this pull request never conflicts with the branch it targets. Merging it is what carries the baseline on to \`${base}\`; leaving it unmerged is harmless, because the next run rebuilds the baseline and reopens (or refreshes) this pull request.`,
    ].join('\n');
    const query = `?state=open&base=${encodeURIComponent(headRef)}&head=${encodeURIComponent(`${owner}:${stackedRef}`)}`;
    const [existing] = (await api(`/pulls${query}`)) ?? [];
    const pull = existing
        ? await api(`/pulls/${existing.number}`, {method: 'PATCH', body: JSON.stringify({title, body})})
        : await api('/pulls', {method: 'POST', body: JSON.stringify({title, body, head: stackedRef, base: headRef})});
    setOutput('pull-request-url', pull.html_url);
    return pull;
}

setOutput('committed', 'true');
setOutput('head-ref', stackedRef);
try {
    const pull = await publishStackedPullRequest();
    summary(`Stacked ${staged.split('\n').join(', ')} on \`${headRef}\` as pull request #${pull.number} (${pull.html_url}).`);
} catch (error) {
    // The commit is pushed and does not depend on the pull request, so a failure
    // here is a permissions or API problem, not a test failure: the next run of
    // this pull request retries it.
    const detail = `${error?.message ?? error}`;
    if (detail.includes('not permitted to create')) {
        console.log('::warning::the workflow token may not open pull requests in this repository — enable "Allow GitHub Actions to create and approve pull requests" in Settings → Actions → General → Workflow permissions');
    }
    console.log(`::warning::could not open the stacked pull request for ${stackedRef} (${detail})`);
}
