import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { answerUserQuestion, checkViability } from './ask.js';
import { runChunker } from './chunker.js';
import { sendNotificationEmail } from './email.js';
import { neon } from '@neondatabase/serverless';
import OpenAI from 'openai';
import 'dotenv/config';

const sql = neon(process.env.DATABASE_URL);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serve frontend files

// ---------------------------------------------------------------------------
// Scheduled Ingestion — runs nightly at 2:00 AM to pick up new blog posts
// The chunker is idempotent: it only processes posts not yet in the chunks table
// ---------------------------------------------------------------------------
cron.schedule('0 2 * * *', () => {
    console.log('[Cron] 🕑 Nightly ingestion job triggered.');
    runChunker();
}, {
    timezone: 'America/New_York'
});

// Run once on startup to catch any posts added while the server was offline
console.log('[Startup] Checking for any un-chunked posts...');
runChunker();

// ---------------------------------------------------------------------------
// API Routes
// ---------------------------------------------------------------------------
app.post('/api/ask', async (req, res) => {
    try {
        const { question, messages, mode = 'client', sessionId } = req.body;

        if (!question && (!messages || messages.length === 0)) {
            return res.status(400).json({ error: 'A question or message history is required.' });
        }

        const input = messages || [{ role: 'user', content: question }];
        const latestQuestion = input[input.length - 1].content;

        // Log the interaction
        sql`INSERT INTO user_interactions (question, mode, session_id) VALUES (${latestQuestion}, ${mode}, ${sessionId})`.catch(err => {
            console.error('Failed to log interaction:', err.message);
        });

        const result = await answerUserQuestion(input, mode);

        // lead qualification (One email per session, with info sufficiency check)
        if (mode === 'client') {
            (async () => {
                // Check if lead email already sent for this session
                const existing = await sql`SELECT lead_email_sent FROM user_interactions WHERE session_id = ${sessionId} AND lead_email_sent = TRUE LIMIT 1`;
                
                if (existing.length === 0) {
                    const shouldNotify = await checkViability(input, result.raw_answer);
                    if (shouldNotify) {
                        await sendNotificationEmail({
                            question: latestQuestion,
                            analysis: result.raw_answer,
                            history: input
                        });
                        // Mark as sent in the database for this specific interaction row
                        await sql`UPDATE user_interactions SET lead_email_sent = TRUE WHERE session_id = ${sessionId}`;
                    }
                }
            })().catch(err => console.error('Lead qualification error:', err.message));
        }

        res.json(result);
    } catch (error) {
        console.error('Error processing question:', error);
        res.status(500).json({ error: 'An error occurred while generating the diagnostic.' });
    }
});

let cachedTopics = null;
let lastTopicUpdate = 0;

app.get('/api/topics', async (req, res) => {
    try {
        // Cache topics for 15 minutes to save API costs
        if (cachedTopics && (Date.now() - lastTopicUpdate < 15 * 60 * 1000)) {
            return res.json({ topics: cachedTopics });
        }

        const logs = await sql`
            SELECT question 
            FROM user_interactions 
            WHERE mode = 'client' 
            AND length(question) > 20
            ORDER BY created_at DESC 
            LIMIT 40
        `;

        if (logs.length < 3) {
            const defaultTopics = [
                "Statute of Limitations in NY",
                "Continuous Representation Doctrine",
                "The 'Case Within a Case' Requirement",
                "Settlement Without Consent",
                "Attorney-Client Privilege Breaches"
            ];
            return res.json({ topics: defaultTopics });
        }

        // Synthesize high-level topics from the messy logs
        const synthesisPrompt = `You are a legal data analyst. Review these recent user queries from a legal malpractice AI:
${logs.map(l => `- ${l.question}`).join('\n')}

Based on these, generate 5 concise "Common Study Topics" (4-7 words each) that represent the most frequent or interesting legal issues these users are facing. 
Avoid conversational snippets like "yes" or "just last week".
Return ONLY a JSON object: {"topics": ["Topic 1", "Topic 2", ...]} `;

        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: synthesisPrompt }],
            response_format: { type: "json_object" }
        });

        const result = JSON.parse(response.choices[0].message.content);
        cachedTopics = result.topics;
        lastTopicUpdate = Date.now();

        res.json({ topics: cachedTopics });
    } catch (error) {
        console.error('Error synthesizing topics:', error);
        res.status(500).json({ error: 'Failed to synthesize topics.' });
    }
});

app.listen(PORT, () => {
    console.log(`\n🚀 Server is running on http://localhost:${PORT}`);
    console.log(`Navigate to http://localhost:${PORT} to view the frontend.\n`);
});
