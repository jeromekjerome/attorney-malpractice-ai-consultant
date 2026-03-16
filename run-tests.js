/**
 * run-tests.js — Test Harness for Attorney Malpractice AI
 *
 * Usage:
 *   node run-tests.js [options]
 *
 * Options:
 *   --input <path>        Test case JSON file        (default: tests/generated-test-cases.json)
 *   --output <path>       Results JSON output path   (default: tests/results-<timestamp>.json)
 *   --cache <path>        Response cache file        (default: tests/.response-cache.json)
 *   --mode <mode>         'consultant' | 'professor' | 'both'  (default: both)
 *   --case <id>           Run only one test case by id
 *   --threshold <score>   Per-turn PASS threshold    (default: 0.70)
 *   --concurrency <n>     Test cases to run in parallel (default: 3)
 *   --verbose             Print full AI responses
 *   --dry-run             Validate JSON structure; skip all AI calls
 *   --no-cache            Ignore and overwrite cached responses
 *   --resume              Skip cases already present in a previous --output file
 *
 * Speed features:
 *   • Parallel cases      — N cases run concurrently (--concurrency).
 *                           Dialogs within a case are sequential (conversation order matters).
 *   • Response cache      — Every answerUserQuestion() call is stored in a local JSON cache
 *                           keyed by [mode, history-hash]. Re-runs and retries skip the
 *                           expensive RAG + OpenAI call entirely.
 *   • Incremental writes  — Each finished case flushes its result to the output file
 *                           immediately, so a mid-run crash loses at most one case.
 *   • --resume            — Reads a prior output file; re-uses completed case results
 *                           without re-running them.
 */

import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import OpenAI from 'openai';
import { answerUserQuestion } from './ask.js';

// ─── CLI Argument Parsing ────────────────────────────────────────────────────

function parseArgs(argv) {
    const args = {};
    for (let i = 2; i < argv.length; i++) {
        const flag = argv[i];
        const next = argv[i + 1];
        switch (flag) {
            case '--input':       args.input       = next; i++; break;
            case '--output':      args.output      = next; i++; break;
            case '--cache':       args.cache       = next; i++; break;
            case '--mode':        args.mode        = next; i++; break;
            case '--case':        args.caseId      = parseInt(next, 10); i++; break;
            case '--threshold':   args.threshold   = parseFloat(next); i++; break;
            case '--concurrency': args.concurrency = parseInt(next, 10); i++; break;
            case '--verbose':     args.verbose     = true; break;
            case '--dry-run':     args.dryRun      = true; break;
            case '--no-cache':    args.noCache     = true; break;
            case '--resume':      args.resume      = true; break;
        }
    }
    return args;
}

const cli         = parseArgs(process.argv);
const INPUT       = cli.input       ?? 'tests/generated-test-cases.json';
const MODES       = cli.mode        ?? 'both';
const CASE_ID     = cli.caseId      ?? null;
const THRESHOLD   = cli.threshold   ?? 0.70;
const CONCURRENCY = cli.concurrency ?? 3;
const VERBOSE     = cli.verbose     ?? false;
const DRY_RUN     = cli.dryRun      ?? false;
const NO_CACHE    = cli.noCache     ?? false;
const RESUME      = cli.resume      ?? false;
const CACHE_FILE  = cli.cache       ?? 'tests/.response-cache.json';

const RUN_TS  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUTPUT  = cli.output ?? `tests/results-${RUN_TS}.json`;

// ─── Response Cache ──────────────────────────────────────────────────────────
// Keyed by a SHA-256 hash of (mode + conversation-history JSON).
// Persisted to disk so it survives between runs.

let responseCache = {};

async function loadCache() {
    if (NO_CACHE) return;
    try {
        const raw = await fs.readFile(CACHE_FILE, 'utf-8');
        responseCache = JSON.parse(raw);
        const count = Object.keys(responseCache).length;
        if (count > 0) console.log(`  📦 Loaded ${count} cached responses from ${CACHE_FILE}`);
    } catch {
        // No cache yet — start fresh silently
    }
}

async function saveCache() {
    if (NO_CACHE) return;
    try {
        await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
        await fs.writeFile(CACHE_FILE, JSON.stringify(responseCache, null, 2), 'utf-8');
    } catch (err) {
        console.warn('  ⚠️  Could not write cache:', err.message);
    }
}

function cacheKey(modeParam, history) {
    const payload = JSON.stringify({ modeParam, history });
    return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

// ─── Incremental Output Writer ───────────────────────────────────────────────
// Maintains an in-memory report object and writes it to disk after each case.

let liveReport = null;

async function initReport(meta) {
    liveReport = { ...meta, summary: {}, cases: [] };
    await flushReport();
}

async function appendCaseResult(caseResult) {
    liveReport.cases.push(caseResult);
    await flushReport();
}

async function flushReport() {
    try {
        await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
        await fs.writeFile(OUTPUT, JSON.stringify(liveReport, null, 2), 'utf-8');
    } catch (err) {
        console.warn('  ⚠️  Could not flush report:', err.message);
    }
}

// ─── Concurrency Pool ────────────────────────────────────────────────────────
// Runs an array of async tasks with at most `limit` running at the same time.

async function runPool(tasks, limit) {
    const results = new Array(tasks.length);
    const queue = tasks.map((task, i) => ({ task, i }));
    const active = new Set();

    await new Promise((resolve, reject) => {
        function next() {
            while (active.size < limit && queue.length > 0) {
                const { task, i } = queue.shift();
                const p = task().then(
                    r => { results[i] = r; active.delete(p); next(); if (active.size === 0 && queue.length === 0) resolve(); },
                    e => reject(e)
                );
                active.add(p);
            }
        }
        next();
    });

    return results;
}

// ─── LLM Judge ──────────────────────────────────────────────────────────────

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function judgeResponses({ expected, actual, turnIndex, modeParam }) {
    const modeLabel = modeParam === 'client' ? 'Consultant (client-facing)' : 'Professor (Socratic seminar)';
    const judgePrompt = `You are an expert evaluator for a legal AI assistant focused on New York attorney malpractice law.

## Task
Assess whether an AI response is semantically equivalent to an expected scripted response.

## Context
- Mode: ${modeLabel}
- Turn number: ${turnIndex + 1}

## Expected Response (scripted baseline)
${expected}

## Actual AI Response (live output)
${actual}

## Scoring (0.00 – 1.00)
- **Topical Accuracy** (0.4 weight): Same legal issue addressed?
- **Behavioral Fidelity** (0.4 weight): Correct turn-number behavior? (e.g., one question only, correct referral timing, phone-ask at turn 5+, milestone at professor turns 3/6/9)
- **Tone Match** (0.2 weight): Professional consultant vs. Socratic professor voice?

Do NOT penalize for different specific citations or phrasing. Judge intent, behavior, and topical coverage.

Respond ONLY with valid JSON:
{
  "score": <0.00–1.00>,
  "topical_accuracy": <0.00–1.00>,
  "behavioral_fidelity": <0.00–1.00>,
  "tone_match": <0.00–1.00>,
  "rationale": "<one sentence>"
}`;

    try {
        const resp = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: 'Precise evaluation engine. Output only valid JSON.' },
                { role: 'user',   content: judgePrompt }
            ],
            response_format: { type: 'json_object' },
            temperature: 0
        });
        const r = JSON.parse(resp.choices[0].message.content);
        return { ...r, pass: r.score >= THRESHOLD };
    } catch (err) {
        console.error('  ⚠️  Judge error:', err.message);
        return { score: 0, topical_accuracy: 0, behavioral_fidelity: 0, tone_match: 0, pass: false, rationale: `Judge error: ${err.message}` };
    }
}

// ─── Cached answerUserQuestion wrapper ───────────────────────────────────────

async function cachedAnswer(historySnapshot, modeParam) {
    const key = cacheKey(modeParam, historySnapshot);

    if (!NO_CACHE && responseCache[key]) {
        process.stdout.write(' [cache hit]');
        return responseCache[key];
    }

    const result = await answerUserQuestion([...historySnapshot], modeParam);
    const value  = result.raw_answer ?? result.answer;

    if (!NO_CACHE) {
        responseCache[key] = value;
        // Async fire-and-forget so we don't block the conversation
        saveCache().catch(() => {});
    }

    return value;
}

// ─── Dialog Runner ───────────────────────────────────────────────────────────
// Runs sequential turns within a single dialog (cannot be parallelized because
// each turn's history depends on the live response from the prior turn).

async function runDialog({ dialog, modeArg, caseId, dialogType }) {
    const modeParam   = modeArg === 'consultant' ? 'client' : 'professor';
    const turnResults = [];
    const liveHistory = [];

    // Build ordered (user, expected-assistant) pairs
    const turnPairs = [];
    for (let i = 0; i < dialog.length; i++) {
        if (dialog[i].role === 'user') {
            turnPairs.push({
                userMsg:           dialog[i].content,
                expectedAssistant: dialog[i + 1]?.role === 'assistant' ? dialog[i + 1].content : null,
                turnIndex:         turnPairs.length
            });
        }
    }

    for (const { userMsg, expectedAssistant, turnIndex } of turnPairs) {
        process.stdout.write(`\n  ▸ Case ${caseId} › ${dialogType} › Turn ${turnIndex + 1}...`);

        liveHistory.push({ role: 'user', content: userMsg });

        if (!expectedAssistant) {
            console.log(' ⚠️  no expected response — skip');
            continue;
        }

        if (DRY_RUN) {
            console.log(' [dry-run]');
            turnResults.push({ turnIndex, userMessage: userMsg, expectedResponse: expectedAssistant,
                liveResponse: '[dry-run]', score: null, pass: null, rationale: 'dry-run' });
            liveHistory.push({ role: 'assistant', content: expectedAssistant });
            continue;
        }

        // ── Live AI call (cached) ────────────────────────────────────────────
        let liveResponse;
        try {
            liveResponse = await cachedAnswer([...liveHistory], modeParam);
        } catch (err) {
            console.log(` ❌ system error: ${err.message}`);
            turnResults.push({ turnIndex, userMessage: userMsg, expectedResponse: expectedAssistant,
                liveResponse: null, score: 0, pass: false, rationale: `System error: ${err.message}` });
            liveHistory.push({ role: 'assistant', content: expectedAssistant });
            continue;
        }

        if (VERBOSE) {
            console.log(`\n\n    ── LIVE RESPONSE ──\n${liveResponse}\n    ──────────────────`);
        }

        // ── Judge ────────────────────────────────────────────────────────────
        const j = await judgeResponses({ expected: expectedAssistant, actual: liveResponse, turnIndex, modeParam });
        const icon = j.pass ? '✅' : '❌';
        console.log(` ${icon} ${j.score.toFixed(2)} | ${j.rationale}`);

        turnResults.push({
            turnIndex,
            userMessage:         userMsg,
            expectedResponse:    expectedAssistant,
            liveResponse,
            score:               j.score,
            topical_accuracy:    j.topical_accuracy,
            behavioral_fidelity: j.behavioral_fidelity,
            tone_match:          j.tone_match,
            pass:                j.pass,
            rationale:           j.rationale
        });

        liveHistory.push({ role: 'assistant', content: liveResponse });
    }

    return turnResults;
}

// ─── Per-Case Runner ─────────────────────────────────────────────────────────
// Runs both dialogs for one test case (consultant, then professor).
// The two dialogs are independent and could theoretically be parallelized,
// but keeping them sequential avoids flooding the OpenAI rate limit.

async function runCase(tc) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`📋 Test Case ${tc.id}: ${tc.category}`);
    console.log(`   Source:  ${tc.source_url ?? 'N/A'}`);
    console.log(`   Q:       ${tc.core_legal_question ?? 'N/A'}`);

    const caseResult = {
        id: tc.id, category: tc.category,
        source_url: tc.source_url, core_legal_question: tc.core_legal_question,
        consultant: null, professor: null
    };

    const dialogsToRun = [];
    if (MODES !== 'professor') dialogsToRun.push({ modeArg: 'consultant', dialog: tc.consultant_dialog, dialogType: 'Consultant' });
    if (MODES !== 'consultant') dialogsToRun.push({ modeArg: 'professor',  dialog: tc.professor_dialog,  dialogType: 'Professor' });

    for (const { modeArg, dialog, dialogType } of dialogsToRun) {
        console.log(`\n┌─ ${dialogType}`);
        const turnResults = await runDialog({ dialog, modeArg, caseId: tc.id, dialogType });

        const scored   = turnResults.filter(t => t.score !== null);
        const passed   = scored.filter(t => t.pass).length;
        const failed   = scored.filter(t => !t.pass).length;
        const skipped  = turnResults.length - scored.length;
        const avgScore = scored.length > 0
            ? scored.reduce((s, t) => s + t.score, 0) / scored.length
            : null;

        const summary = {
            turns:     turnResults.length,
            passed, failed, skipped,
            avg_score: avgScore != null ? +avgScore.toFixed(3) : null,
            pass_rate: (passed + failed) > 0 ? +(passed / (passed + failed)).toFixed(3) : null,
            turn_results: turnResults
        };

        console.log(`└─ ${passed}✅  ${failed}❌  ${skipped}⏩  avg: ${avgScore?.toFixed(2) ?? 'N/A'}`);
        caseResult[modeArg] = summary;
    }

    return caseResult;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
    const startTime = Date.now();

    console.log('╔═══════════════════════════════════════════════════════╗');
    console.log('║   Attorney Malpractice AI — Test Harness              ║');
    console.log('╚═══════════════════════════════════════════════════════╝');
    console.log(`  Input:       ${INPUT}`);
    console.log(`  Output:      ${OUTPUT}`);
    console.log(`  Cache:       ${NO_CACHE ? 'disabled' : CACHE_FILE}`);
    console.log(`  Mode(s):     ${MODES}`);
    console.log(`  Threshold:   ${THRESHOLD}`);
    console.log(`  Concurrency: ${CONCURRENCY} cases in parallel`);
    console.log(`  Dry-run:     ${DRY_RUN}`);
    console.log(`  Resume:      ${RESUME}`);
    if (CASE_ID) console.log(`  Filter:      Case ${CASE_ID} only`);
    console.log('');

    // ── Load test cases ──────────────────────────────────────────────────────
    let testCases;
    try {
        const raw = await fs.readFile(INPUT, 'utf-8');
        testCases = JSON.parse(raw);
    } catch (err) {
        console.error(`❌ Cannot load "${INPUT}": ${err.message}`);
        console.error('   Run: node generate-tests.js');
        process.exit(1);
    }
    if (!Array.isArray(testCases) || testCases.length === 0) {
        console.error('❌ Test cases file is empty or not an array.'); process.exit(1);
    }

    // ── Filter by --case flag ────────────────────────────────────────────────
    let filtered = CASE_ID ? testCases.filter(tc => tc.id === CASE_ID) : testCases;
    if (filtered.length === 0) { console.error(`❌ No case with id=${CASE_ID}`); process.exit(1); }

    // ── Resume: skip already-completed cases ─────────────────────────────────
    let priorResults = [];
    if (RESUME) {
        try {
            const raw = await fs.readFile(OUTPUT, 'utf-8');
            const prior = JSON.parse(raw);
            priorResults = prior.cases ?? [];
            const doneIds = new Set(priorResults.map(c => c.id));
            const before  = filtered.length;
            filtered = filtered.filter(tc => !doneIds.has(tc.id));
            console.log(`  ♻️  Resume: ${doneIds.size} case(s) already complete, ${filtered.length}/${before} remaining.\n`);
        } catch {
            console.log('  ♻️  Resume: no prior output file found — running all cases.\n');
        }
    }

    // ── Validate structure ───────────────────────────────────────────────────
    for (const tc of filtered) {
        for (const [key, dialog] of [['consultant_dialog', tc.consultant_dialog], ['professor_dialog', tc.professor_dialog]]) {
            if (!Array.isArray(dialog)) { console.warn(`⚠️  Case ${tc.id} › ${key} missing/invalid.`); continue; }
            const userTurns = dialog.filter(m => m.role === 'user').length;
            if (userTurns < 8) console.warn(`  ⚠️  Case ${tc.id} › ${key}: ${userTurns} user turns (expected ≥ 8)`);
        }
    }

    // ── Load cache + initialize report ──────────────────────────────────────
    await loadCache();
    await initReport({ run_at: new Date().toISOString(), input_file: INPUT, threshold: THRESHOLD, dry_run: DRY_RUN, modes: MODES });
    // Restore prior results into the report immediately
    for (const r of priorResults) { liveReport.cases.push(r); }

    // ── Run cases in parallel pool ───────────────────────────────────────────
    const tasks = filtered.map(tc => async () => {
        const result = await runCase(tc);
        await appendCaseResult(result);   // incremental flush
        return result;
    });

    const newResults = await runPool(tasks, CONCURRENCY);

    // ── Aggregate totals (prior + new) ────────────────────────────────────────
    const allResults = [...priorResults, ...newResults];
    let totalTurns = 0, totalPassed = 0, totalFailed = 0;
    for (const r of allResults) {
        for (const key of ['consultant', 'professor']) {
            if (!r[key]) continue;
            totalTurns  += r[key].passed + r[key].failed;
            totalPassed += r[key].passed;
            totalFailed += r[key].failed;
        }
    }

    const overallPassRate = totalTurns > 0 ? totalPassed / totalTurns : 0;
    const globalPass      = overallPassRate >= THRESHOLD;
    const elapsedSec      = ((Date.now() - startTime) / 1000).toFixed(1);

    // ── Final report ─────────────────────────────────────────────────────────
    liveReport.summary = {
        cases_run:         allResults.length,
        total_turns:       totalTurns,
        passed:            totalPassed,
        failed:            totalFailed,
        overall_pass_rate: +overallPassRate.toFixed(3),
        overall_pass:      globalPass,
        elapsed_sec:       +elapsedSec
    };
    await flushReport();

    console.log(`\n${'═'.repeat(60)}`);
    console.log('📊 OVERALL RESULTS');
    console.log(`${'═'.repeat(60)}`);
    console.log(`  Cases run      : ${allResults.length}`);
    console.log(`  Total turns    : ${totalTurns}`);
    console.log(`  Passed         : ${totalPassed} (${(overallPassRate * 100).toFixed(1)}%)`);
    console.log(`  Failed         : ${totalFailed}`);
    console.log(`  Pass threshold : ${(THRESHOLD * 100).toFixed(0)}%`);
    console.log(`  Elapsed        : ${elapsedSec}s`);
    console.log(`  Overall        : ${globalPass ? '✅ PASS' : '❌ FAIL'}`);

    console.log('\n  Per-Case Breakdown:');
    for (const r of allResults) {
        const c = r.consultant?.pass_rate != null ? `${(r.consultant.pass_rate * 100).toFixed(0)}%` : '—';
        const p = r.professor?.pass_rate  != null ? `${(r.professor.pass_rate  * 100).toFixed(0)}%` : '—';
        const tag = priorResults.some(pr => pr.id === r.id) ? ' (resumed)' : '';
        console.log(`    Case ${String(r.id).padEnd(2)} [${r.category.padEnd(32)}]  Consultant: ${c.padStart(4)}  Professor: ${p.padStart(4)}${tag}`);
    }

    console.log(`\n📄 Results → ${OUTPUT}`);
    if (!NO_CACHE) console.log(`📦 Cache   → ${CACHE_FILE} (${Object.keys(responseCache).length} entries)`);

    process.exit(globalPass ? 0 : 1);
}

main().catch(err => {
    console.error('\n💥 Fatal error:', err);
    process.exit(1);
});
