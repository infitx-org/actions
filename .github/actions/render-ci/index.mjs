#!/usr/bin/env node
// Render CI summary + persist the metrics snapshot.
//
// Dependency-free. Reads:
//   - report-data/<pkg>.md        per-package test summaries (written upstream)
//   - report-data/coverage.lcov   aggregated coverage (written upstream)
//   - .github/metrics.json on the BASE_REF branch (optional baseline, fetched via git)
// Writes (in GITHUB_WORKSPACE):
//   - ci-report.md   the consolidated markdown
//   - metrics.json   the current snapshot uploaded as the `metrics` artifact
// and appends ci-report.md to the job step summary.
//
// Run standalone for a local dry-run: point the paths/env as you like, e.g.
//   GITHUB_SHA=... GITHUB_RUN_NUMBER=... GITHUB_RUN_ID=... node index.mjs
import {appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';

const workspace = process.env.GITHUB_WORKSPACE;
if (workspace) process.chdir(workspace);

// --- Fetch the committed baseline from the base branch (optional) -------------
// Only meaningful for pull_request runs; BASE_REF is empty on push events.
// Any failure (no remote, no file, first run) simply means "no baseline yet" and
// the renderer falls back to showing the summary without delta columns.
const baseRef = process.env.BASE_REF || '';
if (baseRef) {
    try {
        execFileSync('git', ['fetch', '--quiet', '--depth=1', 'origin', baseRef], {
            stdio: ['ignore', 'ignore', 'ignore'],
        });
        execFileSync('git', ['cat-file', '-e', 'FETCH_HEAD:.github/metrics.json'], {
            stdio: ['ignore', 'ignore', 'ignore'],
        });
        const raw = execFileSync('git', ['show', 'FETCH_HEAD:.github/metrics.json'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        writeFileSync('baseline.json', raw);
    } catch {
        // no baseline available — deltas will be hidden
    }
}

// --- Parse per-package test summaries -----------------------------------------
const dataDir = 'report-data';
const rows = [];
if (existsSync(dataDir)) {
    for (const f of readdirSync(dataDir).filter((x) => x.endsWith('.md'))) {
        const pkg = f.replace(/\.md$/, '');
        const head = readFileSync(join(dataDir, f), 'utf8').split('\n').find((l) => l.startsWith('### ')) ?? '';
        const body = head.includes('\u2014') ? head.slice(head.indexOf('\u2014') + 1) : '';
        if (!body) continue;
        const num = (re) => {
            const m = body.match(re);
            return m ? Number(m[1]) : 0;
        };
        rows.push({pkg, passed: num(/(\d+) passed/), failed: num(/(\d+) failed/), flaky: num(/(\d+) flaky/), total: num(/\((\d+) total\)/)});
    }
    rows.sort((a, b) => (b.failed + b.flaky) - (a.failed + a.flaky) || a.pkg.localeCompare(b.pkg));
}
const sum = (k) => rows.reduce((a, r) => a + r[k], 0);

// --- Parse aggregated coverage (lcov SF:/LF:/LH: grouped by package) ----------
const cov = new Map();
const lcovFile = join(dataDir, 'coverage.lcov');
if (existsSync(lcovFile)) {
    let cur = null;
    for (const line of readFileSync(lcovFile, 'utf8').split('\n')) {
        if (line.startsWith('SF:')) {
            const p = line.slice(3).split('/');
            cur = p[0] === 'core' || p[0] === 'ext' || p[0] === 'app' || p[0] === 'library' ? p[1] : p[0];
            if (!cov.has(cur)) cov.set(cur, {hit: 0, found: 0});
        } else if (line.startsWith('LF:')) {
            cov.get(cur).found += Number(line.slice(3));
        } else if (line.startsWith('LH:')) {
            cov.get(cur).hit += Number(line.slice(3));
        }
    }
}
const crows = [...cov.entries()]
    .map(([p, v]) => ({pkg: p, hit: v.hit, found: v.found, pct: v.found > 0 ? Math.round((v.hit / v.found) * 100) : 0}))
    .filter((x) => x.found > 0)
    .sort((a, b) => b.pct - a.pct);
const covTotals = crows.reduce((a, c) => ({hit: a.hit + c.hit, found: a.found + c.found}), {hit: 0, found: 0});
const covPct = covTotals.found > 0 ? Math.round((covTotals.hit / covTotals.found) * 1000) / 10 : 0;

// --- Baseline (last merged main state; optional on the first run) -------------
let base = null;
if (existsSync('baseline.json')) {
    try {
        base = JSON.parse(readFileSync('baseline.json', 'utf8'));
    } catch {
        base = null;
    }
}
const hasBase = !!base && typeof base?.tests?.total === 'number';
const baseTestsTotal = hasBase ? base.tests.total : null;
// NOTE: top-level aggregate coverage is stored as coverage.lines = {hit, found}
// (see below) — not {hit, total}.
const baseCovPct =
    hasBase && base?.coverage?.lines?.found > 0
        ? Math.round((base.coverage.lines.hit / base.coverage.lines.found) * 1000) / 10
        : null;
const fmtInt = (d) => (d > 0 ? `+${d}` : `${d}`);
const fmtPp = (d) => (d > 0 ? `+${d.toFixed(1)}pp` : `${d.toFixed(1)}pp`);

// --- Persist the current snapshot for the main-side updater --------------------
const packages = {};
for (const r of rows) {
    packages[r.pkg] = {...packages[r.pkg], tests: {passed: r.passed, failed: r.failed, flaky: r.flaky, total: r.total}};
}
for (const c of crows) {
    packages[c.pkg] = {...packages[c.pkg], coverage: {linesHit: c.hit, linesTotal: c.found}};
}
writeFileSync(
    'metrics.json',
    JSON.stringify(
        {
            schema: 1,
            commit: process.env.GITHUB_SHA ?? '',
            run: Number(process.env.GITHUB_RUN_NUMBER ?? 0),
            updatedAt: new Date().toISOString(),
            tests: {total: sum('total'), passed: sum('passed'), failed: sum('failed'), flaky: sum('flaky')},
            coverage: {lines: covTotals},
            packages,
        },
        null,
        2,
    ),
);

// --- Render -------------------------------------------------------------------
const lines = [];
if (rows.length > 0) {
    lines.push('## CI Summary');
    lines.push('');
    const extra = sum('flaky') > 0 ? `, ${sum('flaky')} flaky` : '';
    lines.push(`**${rows.length} package(s) · ${sum('passed')} passed, ${sum('failed')} failed${extra} (${sum('total')} total)** — build #${process.env.GITHUB_RUN_NUMBER}`);
    if (hasBase) {
        const covText =
            baseCovPct !== null ? `, coverage ${covPct}% (${fmtPp(covPct - baseCovPct)})` : '';
        lines.push(`*vs last merged main: tests ${sum('total')} (${fmtInt(sum('total') - baseTestsTotal)})${covText}*`);
    }
    lines.push('');
    const dtCol = hasBase ? ' | Δ Tests' : '';
    lines.push(`| Package | Result | Passed | Failed | Flaky | Total${dtCol} |`);
    lines.push(`| --- | --- | ---: | ---: | ---: | ---:${hasBase ? ' | ---:' : ''} |`);
    for (const r of rows) {
        const icon = r.failed > 0 ? '\u274c' : r.flaky > 0 ? '\u26a0\ufe0f' : '\u2705';
        const dt =
            hasBase && base?.packages?.[r.pkg]?.tests?.total !== undefined
                ? fmtInt(r.total - base.packages[r.pkg].tests.total)
                : '';
        lines.push(`| ${r.pkg} | ${icon} | ${r.passed} | ${r.failed} | ${r.flaky} | ${r.total}${hasBase ? ` | ${dt}` : ''} |`);
    }
    lines.push('');
}
if (crows.length > 0) {
    lines.push('### Coverage');
    lines.push('');
    const covCol = baseCovPct !== null ? ' | Δ' : '';
    lines.push(`| Package | Lines hit / total | Coverage${covCol} |`);
    lines.push(`| --- | ---: | ---:${baseCovPct !== null ? ' | ---:' : ''} |`);
    for (const c of crows) {
        let dpp = '';
        if (baseCovPct !== null && base?.packages?.[c.pkg]?.coverage?.linesTotal > 0) {
            const bp = Math.round((base.packages[c.pkg].coverage.linesHit / base.packages[c.pkg].coverage.linesTotal) * 1000) / 10;
            dpp = fmtPp(c.pct - bp);
        }
        lines.push(`| ${c.pkg} | ${c.hit} / ${c.found} | ${c.pct}%${baseCovPct !== null ? ` | ${dpp}` : ''} |`);
    }
    lines.push('');
}
const runUrl = `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${process.env.GITHUB_REPOSITORY || 'local'}/actions/runs/${process.env.GITHUB_RUN_ID || '0'}`;
if (lines.length === 0) lines.push('## CI Summary', '');
lines.push(`_See the [full run](${runUrl}) for job logs._`);

const report = lines.join('\n') + '\n';
writeFileSync('ci-report.md', report);
const stepSummary = process.env.GITHUB_STEP_SUMMARY;
if (stepSummary) appendFileSync(stepSummary, report);

// Also mirror the markdown into the run log for easy inspection.
console.log(report);
