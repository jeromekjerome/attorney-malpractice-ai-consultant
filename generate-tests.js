/**
 * generate-tests.js — Test Case Generator for Attorney Malpractice AI
 *
 * Implements the full agent.md specification (Steps 1–7):
 *   1. Query Neon DB for all blog posts (preview).
 *   2. Select 6 maximally-diverse posts across 6 legal categories.
 *   3. Read each full post from DB.
 *   4. Extract core legal issue, key facts, doctrine, emotional state.
 *   5. Generate Consultant-path dialog (8–10 turns).
 *   6. Generate Professor-path dialog (8–10 turns).
 *   7. Quality-check every dialog, auto-fix failures, write JSON output.
 *
 * Run with:
 *   node generate-tests.js
 *
 * Output:
 *   tests/generated-test-cases.json
 */

import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';

const sql    = neon(process.env.DATABASE_URL);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const OUTPUT_FILE = 'tests/generated-test-cases.json';

// ─── Category Definitions (agent.md Step 1) ──────────────────────────────────

const CATEGORIES = [
    { id: 'statute_of_limitations',   label: 'Statute of limitations (missed deadline / time-bar)' },
    { id: 'failure_to_communicate',   label: 'Failure to communicate / inform client' },
    { id: 'conflict_of_interest',     label: 'Conflict of interest or duty of loyalty' },
    { id: 'settlement_malpractice',   label: 'Settlement malpractice (unauthorized/uninformed settlement)' },
    { id: 'appellate_procedural',     label: 'Appellate/procedural error (missed filing, wrong court, etc.)' },
    { id: 'damages_case_within_case', label: 'Damages / "case within a case" proof requirement' },
];

// ─── Step 1 & 2: Select Six Diverse Blog Posts ───────────────────────────────

async function selectSixPosts() {
    console.log('\n── Step 1: Fetching blog post previews from Neon...');

    const rows = await sql`
        SELECT url, LEFT(blog_post, 600) AS preview
        FROM bluestone_blog_pages
        ORDER BY RANDOM()
        LIMIT 200
    `;
    console.log(`   Sampled ${rows.length} random posts for selection.`);

    // Ask GPT-4o to select 6 maximally-diverse posts, one per category
    const selectionPrompt = `You are a legal research assistant selecting blog posts for test case generation.

Below are ${rows.length} blog posts from Andrew Bluestone's New York legal malpractice blog (url + first 600 chars each).

Your job: Select exactly ONE post per category from this list:
${CATEGORIES.map((c, i) => `  Slot ${i + 1} — ${c.id}: ${c.label}`).join('\n')}

Rules:
- No two selected posts may share a category.
- If no clean match exists for a category, pick the closest available topic.
- Prefer posts from different years when possible.
- You MUST select exactly 6 posts.

AVAILABLE POSTS:
${rows.map((r, i) => `[${i}] URL: ${r.url}\nPREVIEW: ${r.preview}`).join('\n\n---\n\n')}

Respond ONLY with a JSON object:
{
  "selections": [
    { "category_id": "statute_of_limitations",   "url": "<exact url from list>", "rationale": "<one sentence>" },
    { "category_id": "failure_to_communicate",   "url": "<exact url from list>", "rationale": "<one sentence>" },
    { "category_id": "conflict_of_interest",     "url": "<exact url from list>", "rationale": "<one sentence>" },
    { "category_id": "settlement_malpractice",   "url": "<exact url from list>", "rationale": "<one sentence>" },
    { "category_id": "appellate_procedural",     "url": "<exact url from list>", "rationale": "<one sentence>" },
    { "category_id": "damages_case_within_case", "url": "<exact url from list>", "rationale": "<one sentence>" }
  ]
}`;

    console.log('   Asking GPT-4o to select 6 diverse posts...');
    const resp = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: selectionPrompt }],
        response_format: { type: 'json_object' },
        temperature: 0
    });

    const { selections } = JSON.parse(resp.choices[0].message.content);

    // Validate no duplicate categories
    const usedCategories = new Set();
    const usedUrls       = new Set();
    for (const s of selections) {
        if (usedCategories.has(s.category_id)) throw new Error(`Duplicate category: ${s.category_id}`);
        if (usedUrls.has(s.url))               throw new Error(`Duplicate URL: ${s.url}`);
        // Verify URL exists in the DB results
        if (!rows.find(r => r.url === s.url))  throw new Error(`Selected URL not in DB: ${s.url}`);
        usedCategories.add(s.category_id);
        usedUrls.add(s.url);
    }

    console.log('   ✅ 6 diverse posts selected:');
    for (const s of selections) {
        console.log(`      [${s.category_id}] ${s.url}`);
        console.log(`        → ${s.rationale}`);
    }

    return selections;
}

// ─── Step 3: Read Full Post Text ──────────────────────────────────────────────

async function fetchFullPost(url) {
    const rows = await sql`
        SELECT url, blog_post
        FROM bluestone_blog_pages
        WHERE url = ${url}
    `;
    if (!rows.length) throw new Error(`Post not found in DB: ${url}`);
    return rows[0].blog_post;
}

// ─── Step 4: Extract Core Legal Issue ────────────────────────────────────────

async function extractLegalIssue(url, blogPost, categoryLabel) {
    const prompt = `You are a legal analyst. Read the following New York legal malpractice blog post and extract structured information.

BLOG POST URL: ${url}
CATEGORY: ${categoryLabel}

FULL TEXT:
${blogPost}

Extract and return ONLY a JSON object with these exact keys:
{
  "core_legal_question": "<one sentence — e.g., 'Does missing the statute of limitations bar a legal malpractice claim in New York?'>",
  "key_facts": ["<fact 1>", "<fact 2>", "<fact 3>", "<fact 4>", "<fact 5 (optional)>"],
  "key_doctrine": "<one sentence — the rule or doctrine the post answers>",
  "likely_client_emotional_state": "<e.g., 'frustrated and anxious'>",
  "first_user_message": "<under 20 words — a brief, evocative opening from a non-lawyer client, e.g., 'My lawyer let the deadline pass on my personal injury case. Is it too late?'>"
}`;

    const resp = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.2
    });
    return JSON.parse(resp.choices[0].message.content);
}

// ─── Step 5: Generate Consultant Dialog ──────────────────────────────────────

async function generateConsultantDialog(blogPost, url, issue) {
    const prompt = `You are generating a SCRIPTED TEST DIALOG for an Attorney Malpractice AI system.

## Role: Simulated Non-Lawyer Client
The user is a non-lawyer who is hurt, suspicious of attorneys, and unsure if they have a case.
Emotional state: ${issue.likely_client_emotional_state}
Key facts available: ${issue.key_facts.join('; ')}

## Role: AI Consultant (mirrors ask.js client-mode behavior)
- Turns 1–2: Gather facts. Ask ONE follow-up question. Give NO verdict.
- Turn 3: Give a PRELIMINARY opinion on claim strength. Still NO referral.
- Turn 4: If viable → recommend Andrew Bluestone at (212) 791-5600. If weak → invite more facts.
- Turns 5–10: If engaged and claim is viable → ask for the user's phone number.

## Blog Post Context (use this to ground AI responses in actual doctrine)
URL: ${url}
${blogPost}

## User Persona Rules
- Short, plain language (1–3 sentences per turn).
- Does NOT volunteer all facts at once — answers only what was asked.
- May be slightly evasive or imprecise on dates and details.
- MUST NOT use legal jargon.

## Dialog Construction Rules
- First user message (Turn 1): "${issue.first_user_message}"
- Each subsequent user message: a direct SHORT answer to the AI's prior question.
- Each AI response must be grounded in the blog post's doctrine and case law.
- Aim for 8–10 full turns (8–10 user messages + 8–10 assistant messages = 16–20 items total).
- Stop when: AI has rendered final verdict AND asked for phone number, OR 10 turns reached.
- AI Turn 4 must EITHER recommend Bluestone's number OR invite more facts — NEVER both.
- AI Turn 5+ responses (when claim is viable) must explicitly solicit the user's phone number.

## Output Format
Return ONLY a JSON object with a single key "dialog" containing an array of {role, content} objects.
Alternate strictly: user, assistant, user, assistant, ...
Start with role: "user".`;

    const resp = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
            { role: 'system', content: 'You are a precise test data generator. Output only valid JSON.' },
            { role: 'user',   content: prompt }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.5,
        max_tokens: 4000
    });

    const { dialog } = JSON.parse(resp.choices[0].message.content);
    return dialog;
}

// ─── Step 6: Generate Professor Dialog ───────────────────────────────────────

async function generateProfessorDialog(blogPost, url, issue) {
    const prompt = `You are generating a SCRIPTED TEST DIALOG for an Attorney Malpractice AI system — professor (Socratic seminar) mode.

## Role: Simulated Law Student (2L)
- Knows general tort principles but unfamiliar with malpractice-specific doctrine.
- Gives thoughtful but imperfect answers (2–4 sentences).
- Occasionally makes a minor legal error the professor can gently correct.
- Uses some legal vocabulary (e.g., "duty of care", "proximate cause") but sometimes misapplies it.

## Role: AI Professor (mirrors ask.js professor-mode behavior)
- Turn 1: Present ONE concise hypothetical drawn from the blog post. Ask ONE targeted opening question.
- Every turn: Acknowledge student's answer → correct or affirm → ask exactly ONE next question.
- Turns 3, 6, 9: Provide a MILESTONE PROGRESS ASSESSMENT paragraph BEFORE the next question.
- NEVER give the answer directly. Guide with Socratic prompts.
- Every AI response must end with EXACTLY ONE question mark.
- Build logically: (1) What is the duty? (2) Was it breached? (3) Causation? (4) Case-within-a-case? (5) Damages?

## Blog Post Context
URL: ${url}
${blogPost}

## Dialog Construction Rules
- Aim for 8–10 full turns (16–20 items: alternating user/assistant, starting with assistant for Turn 1 hypothetical presentation).
  IMPORTANT: Start with role "user" (student says something like "I'm ready" or asks an initial question), 
  then role "assistant" (professor presents the hypo and first question).
  Actually — start with role "assistant" presenting the hypothetical and first question, then alternate.
  Wait — to keep it consistent with the test harness which feeds user turns: start with role "user" 
  with a brief "ready" message, then assistant presents the hypo.
- Stop when: student has analyzed all three elements (duty, breach, causation/damages), OR 10 turns reached.
- Each AI turn MUST end with exactly one question mark.
- AI turns 3, 6, and 9 MUST contain an explicit milestone assessment paragraph before the question.

## Output Format
Return ONLY a JSON object with a single key "dialog" containing an array of {role, content} objects.
Start with role: "user" (e.g., "I'm ready for the seminar.").
Then role: "assistant" presents the hypothetical and first question.
Then alternate strictly.`;

    const resp = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
            { role: 'system', content: 'You are a precise test data generator. Output only valid JSON.' },
            { role: 'user',   content: prompt }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.5,
        max_tokens: 4000
    });

    const { dialog } = JSON.parse(resp.choices[0].message.content);
    return dialog;
}

// ─── Step 7: Quality Checks & Auto-Fix ───────────────────────────────────────

function checkDialog(dialog, mode, caseId) {
    const issues = [];
    const userTurns      = dialog.filter(m => m.role === 'user');
    const assistantTurns = dialog.filter(m => m.role === 'assistant');

    // Check 1 & 4: Turn count ≥ 8 user messages
    if (userTurns.length < 8) {
        issues.push(`Only ${userTurns.length} user turns (need ≥ 8)`);
    }

    if (mode === 'consultant') {
        // Check 2: No legal jargon in user turns
        const jargonPattern = /\b(statute of limitations|tort|plaintiff|defendant|proximate cause|duty of care|prima facie|res ipsa|mens rea|voir dire|subrogation|indemnification|fiduciary|malpractice|negligence per se)\b/i;
        userTurns.forEach((m, i) => {
            if (jargonPattern.test(m.content)) {
                issues.push(`User turn ${i + 1} contains legal jargon: "${m.content.substring(0, 80)}..."`);
            }
        });

        // Check 6: Turn 4 (4th assistant message) recommends Bluestone OR invites facts — not both
        const turn4 = assistantTurns[3];
        if (turn4) {
            const hasReferral = /791-5600|Andrew Bluestone/i.test(turn4.content);
            const hasInvite   = /additional|more facts|share|clarify/i.test(turn4.content);
            if (hasReferral && hasInvite) {
                issues.push('Turn 4 assistant response has both referral AND invite-more-facts (should be one or the other)');
            }
        }

        // Check 7: Turn 5+ assistant messages solicit phone number (when claim is viable)
        // We only check if they mention phone number — can't know viability statically
        const turn5plus = assistantTurns.slice(4);
        const anyPhoneAsk = turn5plus.some(m => /phone number|reach out|contact/i.test(m.content));
        if (turn5plus.length > 0 && !anyPhoneAsk) {
            issues.push('No phone number solicitation found in turns 5+ (expected for viable claims)');
        }

    } else {
        // Check 3: Every professor turn ends with exactly one question mark
        assistantTurns.forEach((m, i) => {
            const qMarks = (m.content.match(/\?/g) || []).length;
            if (qMarks === 0) {
                issues.push(`Professor turn ${i + 1} has no question mark`);
            } else if (qMarks > 1) {
                issues.push(`Professor turn ${i + 1} has ${qMarks} question marks (should have exactly 1)`);
            }
        });

        // Check 5: Professor turns 3, 6, 9 have milestone assessment
        [2, 5, 8].forEach(idx => { // 0-indexed
            const t = assistantTurns[idx];
            if (t) {
                const hasMilestone = /progress|assessment|so far|you've|you have|analytical|grasp|strength|gap/i.test(t.content);
                if (!hasMilestone) {
                    issues.push(`Professor turn ${idx + 1} (milestone turn) lacks progress assessment`);
                }
            }
        });
    }

    return issues;
}

async function autoFix(dialog, mode, blogPost, url, issue, caseId, attempt = 1) {
    const problems = checkDialog(dialog, mode, caseId);
    if (problems.length === 0) return dialog;

    if (attempt > 2) {
        console.warn(`   ⚠️  Case ${caseId} ${mode}: Could not auto-fix after ${attempt - 1} attempt(s). Issues: ${problems.join('; ')}`);
        return dialog; // Return best-effort
    }

    console.log(`   🔧 Case ${caseId} ${mode}: Fixing ${problems.length} issue(s) (attempt ${attempt}):`);
    problems.forEach(p => console.log(`      • ${p}`));

    const fixPrompt = `The following ${mode} dialog has quality issues that need to be fixed.

ISSUES TO FIX:
${problems.map((p, i) => `${i + 1}. ${p}`).join('\n')}

CURRENT DIALOG:
${JSON.stringify(dialog, null, 2)}

BLOG POST CONTEXT:
${blogPost}

${mode === 'consultant' ? `CONSULTANT MODE RULES:
- User turns must use plain language only — NO legal jargon like "statute of limitations", "proximate cause", etc.
- Turn 4 (4th assistant response) must EITHER recommend Andrew Bluestone at (212) 791-5600 OR invite more facts — NEVER both at once.
- Turn 5+ assistant responses must ask for the user's phone number (for viable claims).
- There must be at least 8 user turns.` :
`PROFESSOR MODE RULES:
- Every single assistant turn must end with EXACTLY ONE question mark.
- Turns 3, 6, and 9 (0-indexed: 2, 5, 8) of the assistant must contain a milestone progress assessment BEFORE the question.
- There must be at least 8 user turns.`}

Fix ALL issues and return the corrected dialog.
Return ONLY a JSON object: { "dialog": [ { "role": "user"|"assistant", "content": "..." }, ... ] }`;

    const resp = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
            { role: 'system', content: 'You are a precise dialog editor. Fix only what is listed. Output only valid JSON.' },
            { role: 'user',   content: fixPrompt }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3,
        max_tokens: 4000
    });

    const fixed = JSON.parse(resp.choices[0].message.content).dialog;
    return autoFix(fixed, mode, blogPost, url, issue, caseId, attempt + 1);
}

// ─── Main Orchestrator ────────────────────────────────────────────────────────

async function main() {
    console.log('╔═══════════════════════════════════════════════════════╗');
    console.log('║   Attorney Malpractice AI — Test Case Generator       ║');
    console.log('╚═══════════════════════════════════════════════════════╝');
    console.log(`  Output: ${OUTPUT_FILE}\n`);

    // ── Step 1 & 2: Select Posts ─────────────────────────────────────────────
    let selections;
    try {
        selections = await selectSixPosts();
    } catch (err) {
        console.error('❌ Failed to select blog posts:', err.message);
        process.exit(1);
    }

    // ── Steps 3–7: Process Each Post ─────────────────────────────────────────
    const results = [];

    for (let idx = 0; idx < selections.length; idx++) {
        const { category_id, url } = selections[idx];
        const categoryLabel = CATEGORIES.find(c => c.id === category_id)?.label ?? category_id;
        const caseId = idx + 1;

        console.log(`\n${'─'.repeat(60)}`);
        console.log(`📋 Processing Case ${caseId}/6: [${category_id}]`);
        console.log(`   URL: ${url}`);

        try {
            // Step 3: Full post text
            console.log('   ▸ Fetching full post...');
            const blogPost = await fetchFullPost(url);

            // Step 4: Extract legal issue
            console.log('   ▸ Extracting core legal issue...');
            const issue = await extractLegalIssue(url, blogPost, categoryLabel);
            console.log(`   ✅ Core Q: ${issue.core_legal_question}`);
            console.log(`   ✅ Doctrine: ${issue.key_doctrine}`);

            // Step 5: Consultant dialog
            console.log('   ▸ Generating Consultant dialog (8–10 turns)...');
            let consultantDialog = await generateConsultantDialog(blogPost, url, issue);
            console.log(`   ✅ Generated ${consultantDialog.filter(m => m.role === 'user').length} consultant user turns`);

            // Step 6: Professor dialog
            console.log('   ▸ Generating Professor dialog (8–10 turns)...');
            let professorDialog = await generateProfessorDialog(blogPost, url, issue);
            console.log(`   ✅ Generated ${professorDialog.filter(m => m.role === 'user').length} professor user turns`);

            // Step 7: Quality checks & auto-fix
            console.log('   ▸ Running quality checks...');
            consultantDialog = await autoFix(consultantDialog, 'consultant', blogPost, url, issue, caseId);
            professorDialog  = await autoFix(professorDialog,  'professor',  blogPost, url, issue, caseId);

            const consultantIssues = checkDialog(consultantDialog, 'consultant', caseId);
            const professorIssues  = checkDialog(professorDialog,  'professor',  caseId);

            if (consultantIssues.length === 0 && professorIssues.length === 0) {
                console.log('   ✅ All quality checks passed.');
            } else {
                console.warn(`   ⚠️  Remaining issues after fix: ${[...consultantIssues, ...professorIssues].join('; ')}`);
            }

            results.push({
                id: caseId,
                category: category_id,
                source_url: url,
                core_legal_question: issue.core_legal_question,
                key_doctrine: issue.key_doctrine,
                key_facts: issue.key_facts,
                likely_client_emotional_state: issue.likely_client_emotional_state,
                quality_checks: {
                    consultant_issues: consultantIssues,
                    professor_issues: professorIssues
                },
                consultant_dialog: consultantDialog,
                professor_dialog: professorDialog
            });

        } catch (err) {
            console.error(`   ❌ Case ${caseId} failed: ${err.message}`);
            console.error('   Skipping and continuing with remaining posts...');
        }
    }

    // ── Write Output ──────────────────────────────────────────────────────────
    if (results.length === 0) {
        console.error('\n❌ No test cases were generated successfully.');
        process.exit(1);
    }

    await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
    await fs.writeFile(OUTPUT_FILE, JSON.stringify(results, null, 2), 'utf-8');

    console.log(`\n${'═'.repeat(60)}`);
    console.log('✅ Generation Complete');
    console.log(`   Cases generated : ${results.length}/6`);
    console.log(`   Output file     : ${OUTPUT_FILE}`);

    if (results.length < 6) {
        console.warn(`   ⚠️  ${6 - results.length} case(s) failed — review errors above.`);
    }

    // Summary table
    console.log('\n   Category            │ Consultant Turns │ Professor Turns │ Issues');
    console.log('   ─────────────────── │ ──────────────── │ ─────────────── │ ──────');
    for (const r of results) {
        const ct = r.consultant_dialog.filter(m => m.role === 'user').length;
        const pt = r.professor_dialog.filter(m => m.role === 'user').length;
        const qi = (r.quality_checks.consultant_issues.length + r.quality_checks.professor_issues.length);
        const cat = r.category.substring(0, 19).padEnd(19);
        console.log(`   ${cat} │ ${String(ct).padStart(16)} │ ${String(pt).padStart(15)} │ ${qi === 0 ? '✅' : `⚠️  ${qi}`}`);
    }

    console.log('\nNext step → node run-tests.js');
}

main().catch(err => {
    console.error('\n💥 Fatal error:', err);
    process.exit(1);
});
