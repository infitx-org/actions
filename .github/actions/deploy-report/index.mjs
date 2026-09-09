#!/usr/bin/env node
// Publish one report directory to a <owner>/<repo> gh-pages branch and emit the URL.
//
// Dependency-free port of the previous inline bash step. Behaviour is kept as
// close to the original as possible:
//   - token: GITHUB_TOKEN when publishing to the current repo, else report-token
//     input; no token => warn + deployed=false (no error).
//   - clone (or init) the gh-pages branch, copy docs/<tool>/<workflow>/<run>,
//   - touch .nojekyll, prune numeric run dirs beyond keep-reports,
//   - regenerate index.html at docs, docs/<tool>, docs/<tool>/<workflow>,
//   - commit + force push, resolve the pages base URL (custom-domain aware),
//   - outputs: deployed/url + <tool>.url.txt in GITHUB_WORKSPACE.
import {existsSync} from 'node:fs';
import {copyFileSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
const currentRepo = process.env.GITHUB_REPOSITORY || '';

// --- Resolve token -------------------------------------------------------------
const extRepo = (process.env.INPUT_EXT_REPO || '').trim() || currentRepo;
const tool = (process.env.INPUT_TOOL || '').trim();
const runNum = (process.env.INPUT_RUN_NUM || '').trim();
const workflow = (process.env.INPUT_WORKFLOW || '').trim();
const reportSrc = (process.env.INPUT_REPORT_SRC || '').trim();
const keep = Math.max(1, Number(process.env.INPUT_KEEP_REPORTS || '15') || 15);
const reportToken = (process.env.INPUT_REPORT_TOKEN || '').trim();

const token = extRepo === currentRepo ? (process.env.GITHUB_TOKEN || '').trim() : reportToken;

function setOutput(name, value) {
    const file = process.env.GITHUB_OUTPUT;
    if (file) writeFileSync(file, `${name}=${value}\n`, {flag: 'a'});
}

if (!tool || !runNum || !workflow || !reportSrc) {
    console.error(`deploy-report: missing required input (tool='${tool}' runNum='${runNum}' workflow='${workflow}' reportSrc='${reportSrc}')`);
    setOutput('deployed', 'false');
    process.exit(1);
}
if (!token) {
    console.log(`::warning::No token available to publish to ${extRepo} (set REPORT_TOKEN for an external reports repo) — skipping deploy`);
    setOutput('deployed', 'false');
    process.exit(0);
}

const [owner, extName] = extRepo.split('/');
const pagesBranch = 'gh-pages';
const authUrl = `https://x-access-token:${token}@github.com/${extRepo}.git`;
const work = join(process.env.RUNNER_TEMP || tmpdir(), `publish-${tool}`);

function run(args, opts = {}) {
    const {cwd, ignore = false} = opts;
    try {
        return execFileSync('git', args, {cwd, stdio: ignore ? 'ignore' : ['ignore', 'pipe', 'inherit'], encoding: 'utf8'});
    } catch (err) {
        if (!ignore) throw err;
        return '';
    }
}
const ok = (args, opts = {}) => {
    try {
        execFileSync('git', args, {...opts, stdio: 'ignore'});
        return true;
    } catch {
        return false;
    }
};

// --- Prepare the gh-pages working tree -----------------------------------------
rmSync(work, {recursive: true, force: true});
if (ok(['ls-remote', '--heads', authUrl, pagesBranch])) {
    run(['clone', '-q', '--depth', '1', '--branch', pagesBranch, authUrl, work], {cwd: undefined});
} else {
    mkdirSync(work, {recursive: true});
    run(['init', '-q'], {cwd: work});
    run(['checkout', '-q', '-b', pagesBranch], {cwd: work});
}
run(['config', 'user.email', 'actions@github.com'], {cwd: work});
run(['config', 'user.name', 'github-actions'], {cwd: work});
run(['config', 'pull.rebase', 'false'], {cwd: work});

// --- Stage this run's report ---------------------------------------------------
const wf = workflow.replace(/\s+/g, '-');
const runDir = join('docs', tool, wf, runNum);
mkdirSync(join(work, runDir), {recursive: true});
const src = join(workspace, reportSrc);
if (existsSync(src)) {
    for (const entry of readdirSync(src)) {
        copyRecursive(join(src, entry), join(work, runDir, entry));
    }
} else {
    console.log(`::warning::report source not found: ${reportSrc}`);
}
writeFileSync(join(work, 'docs', '.nojekyll'), '');

// --- Prune old numeric run directories -----------------------------------------
const root = join(work, 'docs', tool, wf);
const numericDirs = readdirSync(root, {withFileTypes: true})
    .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
    .map((d) => d.name)
    .sort((a, b) => Number(a) - Number(b));
if (numericDirs.length > keep) {
    for (const old of numericDirs.slice(0, numericDirs.length - keep)) {
        rmSync(join(root, old), {recursive: true, force: true});
    }
}

// --- Regenerate index.html at each level ---------------------------------------
genIndex(join(work, 'docs', tool, wf), `${tool} — ${wf}`);
genIndex(join(work, 'docs', tool), `${tool} reports`);
genIndex(join(work, 'docs'), 'Reports');

// --- Commit + force push --------------------------------------------------------
run(['add', '-A'], {cwd: work});
if (!ok(['diff', '--cached', '--quiet'], {cwd: work})) {
    run(['commit', '-q', '-m', `report(${tool}): ${wf} run ${runNum}`], {cwd: work});
    run(['push', '-q', '--force', authUrl, `HEAD:${pagesBranch}`], {cwd: work});
}

// --- Resolve the base URL (custom-domain aware) ---------------------------------
let base = '';
try {
    const gh = execFileSync('gh', ['api', `/repos/${extRepo}/pages`, '--jq', '.html_url'], {
        env: {...process.env, GH_TOKEN: token},
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (/^https?:/.test(gh.trim())) base = gh.trim();
} catch {
    // fall back below
}
if (!base) base = `https://${owner}.github.io/${extName}`;
base = base.replace(/\/+$/, '');
const url = `${base}/${tool}/${wf}/${runNum}/`;

setOutput('deployed', 'true');
setOutput('url', url);
writeFileSync(join(workspace, `${tool}.url.txt`), url, 'utf8');
console.log(`Published ${tool} report: ${url}`);

// --- Helpers -------------------------------------------------------------------
function copyRecursive(src, dst) {
    if (statSync(src).isDirectory()) {
        mkdirSync(dst, {recursive: true});
        for (const entry of readdirSync(src)) copyRecursive(join(src, entry), join(dst, entry));
    } else {
        copyFileSync(src, dst);
    }
}
function genIndex(dir, title) {
    const subs = readdirSync(dir, {withFileTypes: true})
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort((a, b) => a.localeCompare(b, undefined, {numeric: true}));
    const rows = subs.map((s) => `<li><a href="${s}/">${s}</a></li>`).join('\n');
    const html =
        '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>' +
        title +
        '</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><h1>' +
        title +
        '</h1><ul>\n' +
        rows +
        (rows ? '\n' : '') +
        '</ul></body></html>\n';
    writeFileSync(join(dir, 'index.html'), html);
}
