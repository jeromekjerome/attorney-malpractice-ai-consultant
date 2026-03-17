# Andrew Bluestone | Legal Malpractice Diagnostic Assistant

**A Retrieval-Augmented Generation (RAG) platform to diagnose legal malpractice queries based exclusively on New York case law and Andrew Bluestone's legal blog.**

This application leverages a modernized tech stack combining an optimized serverless vector database (Neon Postgres) with OpenAI's natural language and embedding models (`gpt-4o`, `gpt-4o-mini`, `text-embedding-3-small`). The front end provides a sleek, subscriber-ready interface built entirely with responsive, vanilla HTML/CSS/JS glassmorphism.

---

## Architecture Overview

*   **Frontend**: A responsive Vanilla JS & CSS UI that queries the backend API.
*   **Backend Server**: A streamlined Node.js (Express) server acting as the bridge between subscribers and the RAG infrastructure.
*   **Vector Database**: Neon Postgres loaded with `pgvector` to store the thousands of tokenized embeddings of legal blog texts.
*   **AI Engine**: OpenAI's API.
    *   **Retrieval**: `text-embedding-3-small` generates 1536-dimensional query vectors and matches them using cosine similarity (`<=>`) in Neon.
    *   **Re-ranking**: `gpt-4o-mini` re-ranks the top vector results to surface the most citation-rich, legally relevant chunks.
    *   **Generation**: `gpt-4o` interprets the matched legal excerpts and diagnostically answers the subscriber.
    *   **Auxiliary tasks** (lead qualification, topic synthesis, citation verification): `gpt-4o-mini`.
*   **Citation Verification**: CourtListener API (optional) cross-references every legal citation in real time.

---

## AI Modes

The assistant supports two operating modes, selectable via the `mode` field in the `/api/ask` request body:

### Client Mode (`mode: "client"`) — Default
Acts as an expert New York Legal Malpractice Consultant. The assistant:
1. Gathers facts conversationally, asking **one focused follow-up question** if the scenario is incomplete.
2. On sufficient facts, renders a structured diagnostic with three sections: **Core Issue**, **Relevant NY Rules & Precedent**, and **Application to Your Facts**.
3. On Turn 3+, recommends contacting Andrew Bluestone at **(212) 791-5600** and solicits the user's phone number if the claim appears viable.

### Professor Mode (`mode: "professor"`) — Socratic Seminar
Acts as Professor Andrew Bluestone conducting a one-on-one law school Socratic seminar. The assistant:
1. Opens with a legal malpractice hypothetical drawn from the case law context.
2. Poses **exactly one question per turn**, building sequentially from broad duty-of-care analysis down to damages and the "case within a case" doctrine.
3. Acknowledges and corrects student answers before advancing.
4. Delivers a **milestone progress assessment** every third turn (turns 3, 6, 9).

---

## RAG Pipeline (Enhanced)

The retrieval pipeline is a multi-stage process:

1. **Vector Search** — Embeds the user's query and retrieves the top 20 candidate chunks from `bluestone_blog_chunks` by cosine similarity.
2. **Citation Filter** — Filters the 20 candidates down to only those containing complete legal citations (case name + reporter reference). Falls back to raw vector results if none qualify.
3. **LLM Re-ranking** — Sends the filtered candidates to `gpt-4o-mini`, which selects the **3 most legally relevant** chunks for the user's specific scenario.
4. **Context Injection** — The top 3 chunks are injected into the system prompt alongside the full conversation history.

---

## Citation Verification (CourtListener Integration)

When `COURTLISTENER_TOKEN` is configured, every AI response is automatically processed by a live citator pipeline:

*   **Direct Citation Lookup** — Submits the full response text to CourtListener's citation-lookup endpoint. Found citations are annotated with a `[✅ Verified](url)` badge linking to the CourtListener case page. Citations that cannot be verified (HTTP 404) are **automatically stripped** from the response along with their surrounding case name and any orphaned punctuation.
*   **Orphaned Case Name Repair** — For case names that appear without a reporter citation, the pipeline performs a secondary CourtListener name search. It then uses `gpt-4o-mini` to confirm whether any search result unambiguously matches the mentioned case. If confirmed, the full verified citation is reconstructed and linked. If not, the case name is stripped.
*   **Forward Citation Profiler** — For each verified citation, the pipeline fetches the most recent opinions that have cited it (using CourtListener's `opinions-cited` API). This data is appended to the response as a **"📡 Recent Precedent Update"** section, showing whether the cited principles have been recently reaffirmed or distinguished.

> If `COURTLISTENER_TOKEN` is not set, citation verification is skipped gracefully and responses are returned as-is.

---

## Lead Qualification & Email Alerts

In `client` mode, every AI response triggers a background viability check:

*   `checkViability()` sends the full conversation history and the AI's analysis to `gpt-4o-mini`, which evaluates whether the user has a prima facie colorable malpractice case (attorney-client relationship, breach, proximate cause, damages) **and** whether enough facts have been provided to justify an intake alert.
*   If both criteria are met, `sendNotificationEmail()` fires a notification to the configured address with the user's question, the AI's diagnostic, and the full conversation history.
*   **One email per session** — the `lead_email_sent` flag in `user_interactions` prevents duplicate alerts for the same session.

---

## Dynamic Topics API

`GET /api/topics` returns five synthesized "Common Study Topics" derived from recent user queries:

*   Fetches the 40 most recent `client`-mode questions from `user_interactions`.
*   Sends them to `gpt-4o-mini` which condenses them into 5 high-level topic labels (4–7 words each).
*   Results are **cached for 15 minutes** to reduce API costs.
*   Falls back to a static default list if fewer than 3 queries exist in the database.

---

## Nightly Ingestion (Cron)

The server runs an idempotent blog ingestion job via `node-cron`:

*   **Nightly at 2:00 AM ET** — `runChunker()` scans `bluestone_blog_pages` for any posts not yet present in `bluestone_blog_chunks` and embeds + stores them.
*   **On startup** — The same job runs once immediately to catch any posts added while the server was offline.

---

## ⚙️ Configuration & Environment Variables

This application requires specific secrets to interact with the database, OpenAI, CourtListener, and the email relay.

### 1. Local Configuration (Development)

Create a `.env` file at the root of your project:

```env
# Neon PostgreSQL connection string
DATABASE_URL=postgres://your_neon_user:your_neon_password@ep-your-database-id.us-east-2.aws.neon.tech/neondb?sslmode=require

# OpenAI API key
OPENAI_API_KEY=sk-proj-your-actual-api-key-here...

# CourtListener API token (optional — enables live citation verification)
COURTLISTENER_TOKEN=your-courtlistener-token

# Email notification settings (optional — enables lead alert emails)
SMTP_HOST=smtp.your-provider.com
SMTP_PORT=465
SMTP_USER=your@email.com
SMTP_PASS=your-smtp-password
NOTIFICATION_EMAIL=andrew@bluestonelaw.com

# Server port (optional, defaults to 3000)
PORT=3000
```

**⚠️ SECURITY WARNING:** Never commit your `.env` file to your Git repository. Exposing these keys could lead to unexpected resource billing by malicious actors.

### 2. Live Hosting Configuration (Production)

If deploying to a service like Render, Railway, or Heroku, do **not** upload the `.env` file. Instead:

1. Navigate to the **Environment Variables** (or Config Vars) settings panel of your chosen host.
2. Manually add each key/value pair using the precise strings from your local `.env`.
3. The Node.js application is pre-configured to dynamically pull `process.env.*` variables during execution.

---

## 🚀 Setup & Installation

1. **Clone the project:**
   Ensure you have [Node.js](https://nodejs.org/) installed on your machine.

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Set up the database:**
   ```bash
   node setup-db.js
   ```

4. **Ingest blog content:**
   ```bash
   node backfill.js   # embeds full posts
   node chunker.js    # chunks and embeds for RAG
   ```

5. **Start the application:**
   ```bash
   npm start
   ```

6. **Access the Application:**
   Open your browser and navigate to `http://localhost:3000`

---

## 🛠 Database Scripts & Tooling

*   **`node db.js`**: Quick diagnostic tool to verify the `.env` connection to Neon Postgres.
*   **`node backfill.js`**: Batching worker that cycles through raw blog articles in `bluestone_blog_pages`, embeds them via OpenAI, and saves the vectors to Neon. Contains back-off retry logic to handle rate limits.
*   **`node chunker.js`**: Subdivides raw post text into 1,000-character chunks with a 150-character sliding-window overlap for optimal semantic matching. Embeds each chunk into the `bluestone_blog_chunks` table. **Idempotent** — safe to run multiple times.
*   **`node inspect-schema.js`**: Prints the schema of all Neon tables.
*   **`node check-tables.js`**: Verifies table row counts and data integrity.
*   **`node check-logs.js`**: Displays recent entries from `user_interactions`.

---

## 🧪 Testing Suite

The project includes a full automated testing harness.

### Generating Test Cases

```bash
npm run generate-tests
```

Runs `generate-tests.js`, which connects to the database, selects six maximally diverse blog posts across six malpractice categories (statute of limitations, failure to communicate, conflict of interest, settlement malpractice, procedural error, damages), and generates multi-turn dialog scripts for both **Consultant** and **Professor** modes. Output is written to `tests/generated-test-cases.json`.

### Running Tests

```bash
npm test                      # Run all tests
npm run test:consultant       # Consultant mode only
npm run test:professor        # Professor mode only
npm run test:fast             # Run with concurrency 6
npm run test:resume           # Resume a previously interrupted run
npm run test:no-cache         # Bypass cached results
npm run test:dry-run          # Validate test cases without making API calls
```

---

## 🔄 Environment Mode Switching

Switch between test and production environment configurations:

```bash
npm run mode:test    # Load test environment settings
npm run mode:prod    # Load production environment settings
```

These commands invoke `switch-env.js`, which swaps the active `.env` configuration.

---

## API Reference

### `POST /api/ask`

Submit a question or multi-turn conversation to the diagnostic AI.

**Request body:**
```json
{
  "question": "My lawyer missed the statute of limitations.",
  "messages": [{ "role": "user", "content": "..." }, ...],
  "mode": "client",
  "sessionId": "unique-session-id"
}
```

- `question`: Single question string (used if `messages` is absent).
- `messages`: Full conversation history as an array of `{ role, content }` objects. Takes precedence over `question`.
- `mode`: `"client"` (default) or `"professor"`.
- `sessionId`: Optional. Used to deduplicate lead notification emails. Auto-generated if omitted.

**Response:**
```json
{
  "answer": "Markdown-formatted response with verified citations and disclaimer.",
  "raw_answer": "Same as answer, without the disclaimer.",
  "sources": [{ "post_url": "...", "chunk_content": "...", "similarity": 0.92 }]
}
```

### `GET /api/topics`

Returns five synthesized topic labels based on recent user queries.

**Response:**
```json
{
  "topics": ["Statute of Limitations in NY", "Continuous Representation Doctrine", ...]
}
```
