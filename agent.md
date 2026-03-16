# Agent: Test Case Generator — Andrew Bluestone Malpractice AI

## Mission

You are a test-case-generation agent for the Attorney Malpractice AI application. Your
job is to read six carefully selected blog posts from the `bluestone_blog_pages` database
table, extract the core legal issue from each post, and produce **two parallel multi-turn
dialog scripts** for each post:

1. **Consultant Path** — modeled on the `client` mode in `ask.js`
2. **Professor Path** — modeled on the `professor` mode in `ask.js`

Each dialog must have **up to 10 turns** (a "turn" = one user message + one AI response).
The dialogs should be clean, minimal, and realistic so that they are easy to evaluate
automatically. Write the output to `tests/generated-test-cases.json`.

---

## Step 1 — Select Six Representative Blog Posts

Connect to the Neon database using `process.env.DATABASE_URL`. Run the following query to
retrieve all available blog posts (title/URL + first 600 characters of content):

```sql
SELECT url, LEFT(blog_post, 600) AS preview
FROM bluestone_blog_pages
ORDER BY url;
```

From the full list, select **exactly six** posts that are maximally diverse. Use the
following diversity criteria — each selected post must cover a different category:

| Slot | Category |
|------|----------|
| 1 | Statute of limitations (missed deadline / time-bar) |
| 2 | Failure to communicate / inform client |
| 3 | Conflict of interest or duty of loyalty |
| 4 | Settlement malpractice (unauthorized/uninformed settlement) |
| 5 | Appellate/procedural error (missed filing, wrong court, etc.) |
| 6 | Damages / "case within a case" proof requirement |

If a clean match for a category is absent, substitute the closest available topic, but
**never select two posts from the same category**. Record the `url` and its matched
category for each of the six selections.

---

## Step 2 — Extract Core Legal Issue Per Post

For each of the six selected posts, read the **full** `blog_post` text from the database:

```sql
SELECT url, blog_post
FROM bluestone_blog_pages
WHERE url = '<selected_url>';
```

From the full text, extract:

- **Core Legal Question** (one sentence, e.g., "Does missing the statute of limitations
  bar a legal malpractice claim in New York?")
- **Key Facts** from the post that a realistic client would mention (3–5 bullet points)
- **Key Doctrine or Rule** the post answers (one sentence)
- **Likely Client Emotional State** (e.g., "frustrated and anxious", "confused and
  hesitant") — this will set the tone for the simulated user

---

## Step 3 — Generate Consultant-Path Dialog (up to 10 turns)

For each of the six posts, produce a consultant-mode dialog following these rules:

### User Persona Rules
- The simulated user is a **non-lawyer** who is hurt, suspicious of attorneys, and not
  sure if they have a case.
- They speak in **short, plain language** (1–3 sentences per turn).
- They do **not** volunteer all facts at once — they answer what was asked and nothing
  more.
- They may be slightly evasive or imprecise on dates and details.
- They should NOT use legal jargon.

### AI Consultant Behavior (mirror `ask.js` client-mode logic)
- **Turns 1–2:** Gather facts. Ask one follow-up question. Do not render a verdict.
- **Turn 3:** Give a preliminary opinion on claim strength. Still no referral.
- **Turn 4:** If viable, recommend calling Andrew Bluestone at (212) 791-5600. If weak,
  invite more facts.
- **Turns 5–10:** If still engaged and viable — ask for the user's phone number so the
  office can reach out.

### Turn Construction
Write each dialog as a sequence of `{ role, content }` pairs:
- `role: "user"` for the simulated client
- `role: "assistant"` for the AI consultant

Keep the **first user message** brief and evocative (under 20 words). Good examples:
- "My lawyer let the deadline pass on my personal injury case. Is it too late?"
- "My attorney settled my case without telling me. Can I sue her?"

Each subsequent user message should be a **direct, short answer** to whatever question the
AI asked in the prior turn — NOT a comprehensive fact dump.

Aim for **8–10 turns**. Stop the dialog when:
- The AI has rendered a final verdict AND asked for the user's phone number, OR
- 10 turns have been reached, whichever comes first.

---

## Step 4 — Generate Professor-Path Dialog (up to 10 turns)

For the **same six posts**, produce a professor-mode Socratic dialog following these rules:

### Student Persona Rules
- The simulated student is a **second-year law student** who knows general tort principles
  but is unfamiliar with malpractice-specific doctrine.
- They give **thoughtful but imperfect answers** (2–4 sentences).
- They occasionally make a minor legal error that the professor can gently correct.
- They should use some legal vocabulary (e.g., "duty of care", "proximate cause") but
  sometimes misapply it.

### AI Professor Behavior (mirror `ask.js` professor-mode logic)
- **Turn 1:** Present one concise hypothetical drawn from the blog post. Ask one targeted
  opening question.
- Every subsequent turn: Acknowledge the student's answer → correct or affirm → ask ONE
  next question. Never list multiple questions.
- **Every 3rd turn (turns 3, 6, 9):** Provide a milestone progress assessment before the
  next question.
- Never give the answer directly. Guide the student with Socratic prompts.

### Turn Construction
Same `{ role, content }` structure as the consultant path.

The dialog should build logically from broad to specific:
1. What is the general duty?
2. Was it breached here?
3. What does the client need to prove to show causation?
4. What is the "case within a case" doctrine and does it apply?
5. What are the damages?

Aim for **8–10 turns**. Stop when:
- The student has arrived at a complete analysis of all three elements (duty, breach,
  causation/damages), OR
- 10 turns have been reached.

---

## Step 5 — Output Format

Write the output to `tests/generated-test-cases.json` in the following structure:

```json
[
  {
    "id": 1,
    "category": "statute_of_limitations",
    "source_url": "https://...",
    "core_legal_question": "...",
    "key_doctrine": "...",
    "consultant_dialog": [
      { "role": "user",      "content": "..." },
      { "role": "assistant", "content": "..." },
      ...
    ],
    "professor_dialog": [
      { "role": "user",      "content": "..." },
      { "role": "assistant", "content": "..." },
      ...
    ]
  },
  ...
]
```

- Total output: **6 objects** in the top-level array.
- Each object must have **both** `consultant_dialog` and `professor_dialog`.
- Each dialog array must have between **16 and 20 items** (8–10 full turns × 2 roles).

---

## Step 6 — Quality Checks

Before writing the file, verify:

1. **No two posts share the same category.**
2. **No consultant dialog contains legal jargon in the user turns** (the user should
   sound like a real person, not a law student).
3. **Every professor-mode turn ends with exactly one question mark.**
4. **Turn counts**: count `role: "user"` messages in each dialog — must be ≥ 8.
5. **The professor's Turn 3, 6, and 9 responses** each contain an explicit milestone
   assessment paragraph before the question.
6. **The consultant's Turn 4 response** either recommends Andrew Bluestone's number or
   invites more facts — never both.
7. **The consultant's Turn 5+ responses** (if dialog is that long) solicit the user's
   phone number when the claim is viable.

If any quality check fails, fix the offending dialog before writing the file.

---

## Step 7 — Execution Instructions

This agent runs as a **Node.js ES module** script. The script should:

1. Import `dotenv/config`, `@neondatabase/serverless`, `openai`, and `fs/promises`.
2. Connect to the Neon database using `process.env.DATABASE_URL`.
3. Use `openai` (model: `gpt-4o`) to generate the dialogs — pass the full post text as
   context in the system message.
4. Write the final JSON to `tests/generated-test-cases.json` using `fs.writeFile`.
5. Print progress to `stdout` for each of the six posts as they are processed.
6. If any post fails (DB error, OpenAI error), log the error, skip that post, and
   continue with the remaining five.

**Create this script as `generate-tests.js`** in the project root. It should be runnable
with:

```
node generate-tests.js
```

---

## Context: System Architecture

The application runs on:
- **Database:** Neon (PostgreSQL) — tables `bluestone_blog_pages` (full posts) and
  `bluestone_blog_chunks` (embedded chunks for RAG)
- **AI:** OpenAI `gpt-4o` for answers, `gpt-4o-mini` for re-ranking and evaluation,
  `text-embedding-3-small` for vector search
- **Modes:** `client` (consultant) and `professor` — both implemented in `ask.js` via the
  `answerUserQuestion(messages, mode)` export
- **Citation verification:** CourtListener API (optional — test scripts do NOT need to
  invoke this)
- **Turn logic:** The `ask.js` system prompts change behavior at turns 3, 4, and 5+

When writing dialog scripts, the AI assistant turns must mirror what `ask.js` would
actually say given those turn numbers and the blog post context — but the dialogs are
**static pre-written scripts**, not live API calls. They are used to verify that real
`ask.js` responses stay on-persona and on-topic when fed the same inputs.

---

## Notes for the Human Developer

- The generated `tests/generated-test-cases.json` file is intended for use with an
  automated test harness (not yet built). In that harness, each `user` turn will be fed
  into the live `answerUserQuestion()` function and the live AI response will be compared
  against the `assistant` turn in the script for semantic similarity.
- When writing the simulated user turns, keep in mind that **real users will be messier**
  — they may repeat themselves, give irrelevant details, or misremember dates. The test
  dialogs should be clean baselines that map to the ideal path; edge-case tests (messy
  input) can be added later.
- The six blog posts should ideally come from different years if possible, to ensure the
  dataset is not temporally clustered.
