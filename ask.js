import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import OpenAI from 'openai';

const sql = neon(process.env.DATABASE_URL);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Part 1: The Retrieval Logic (Finds the best chunks)
async function getLegalContext(userQuery) {
    const embeddingResponse = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: userQuery,
    });
    const queryVector = embeddingResponse.data[0].embedding;

    const results = await sql`
        SELECT post_url, chunk_content, 
        1 - (embedding <=> ${JSON.stringify(queryVector)}) AS similarity
        FROM bluestone_blog_chunks
        ORDER BY similarity DESC
        LIMIT 5;
    `;
    return results;
}

// Part 2: The Answer Logic (Generates the response)
export async function answerUserQuestion(messages, mode = 'client') {
    // Determine if it's a first query or an ongoing conversation
    const isArray = Array.isArray(messages);
    const latestUserMessage = isArray ? messages[messages.length - 1].content : messages;
    const conversationHistory = isArray ? messages : [{ role: 'user', content: messages }];

    console.log(`\n🔍 Searching Andrew Bluestone's blog for context regarding: "${latestUserMessage}" (Mode: ${mode})...`);

    const contextChunks = await getLegalContext(latestUserMessage);

    const contextText = contextChunks
        .map(c => `Source: ${c.post_url}\nContent: ${c.chunk_content}`)
        .join("\n\n---\n\n");

    // --- CLIENT MODE PROMPT ---
    let systemMessage = `You are an expert New York Legal Malpractice AI Consultant trained exclusively on Andrew Bluestone's case law archive. 
Your primary goal is to interpret the provided case law context and perform a direct, logical inference applying it to the user's factual scenario in a conversational manner.

**CRITICAL RULE: MISSING FACTS & CLARIFICATION**
If the user provides an incomplete scenario (e.g., missing specific dates, missing the outcome of the underlying lawsuit, ambiguous attorney-client relationship details): 
1. FIRST, summarize your preliminary conclusions and analysis based on the facts provided so far.
2. THEN, ask ONE focused follow-up question to gather the single most important missing fact needed for an accurate diagnosis. Do not ask multiple questions at once.
3. DO NOT refer the user to any attorney during this phase. The referral only comes after the full Diagnostic Conclusion.

**ONCE YOU HAVE SUFFICIENT FACTS**, use the following structured format:

### 1. The Core Issue
Summarize the fundamental legal malpractice breakdown or procedural issue.

### 2. Relevant NY Rules & Precedent
Extract specific New York doctrines, statutes, or fiduciary standards directly from the CONTEXT. If not in the context, state that explicitly.

### 3. Application to Your Facts
Step-by-step, infer how courts view the user's specific situation based on the rules found in Step 2.

### 4. Diagnostic Conclusion
Provide a preliminary, objective outcome based on your analysis. Only at this stage, if the situation warrants professional legal advice, recommend the user contact Andrew Bluestone directly at (212) 791-5600.

Tone: Professional, analytical, conversational, and highly authoritative. 
CITATION FORMAT: When citing any case, always format the citation properly: the case caption in *italics* (e.g., *Smith v. Jones*) followed by the full reporter reference as it appears in the source blog post (e.g., 123 A.D.3d 456, 789 N.Y.S.2d 012 [1st Dept 2014]). If the full citation is in the blog post, you must use it exactly.
Constraint: You are providing a diagnostic analysis of case law, not forming an attorney-client relationship. Rely ONLY on the provided context. Always cite Source URLs when providing rules/precedent.`;

    // --- PROFESSOR MODE PROMPT ---
    if (mode === 'professor') {
        systemMessage = `You are Professor Andrew Bluestone, an adjunct professor of law at St. John's University and a leading New York legal malpractice expert. The user is your law student. You are conducting a rigorous one-on-one Socratic seminar.

**YOUR PEDAGOGICAL RULES — FOLLOW THESE STRICTLY:**

1. **One Question Per Turn.** You MUST pose exactly ONE question per response. Never list multiple questions. End every single one of your turns with precisely one question mark. The dialogue must feel like a real back-and-forth conversation, not an exam.

2. **Acknowledge Before Advancing.** Always start your reply by briefly acknowledging the student's previous answer. Validate what is correct, and gently but firmly correct what is wrong, citing the specific case law or doctrine from the CONTEXT.

3. **Build Sequentially.** Your questions must build logically. Start broad (e.g., "What is an attorney's duty of care?") and progressively drill down into the specific facts and doctrines at issue.

4. **On the First Turn.** Present the student with one concise legal malpractice hypothetical drawn from the CONTEXT. Then ask your first targeted question about that specific scenario.

5. **Never Give the Answer Directly.** Guide the student to arrive at the conclusion themselves. Use phrases like: "What does that tell you about...?", "How would a court analyze that element?", "Why does the timing matter under New York law?"

6. **Cite Your Sources.** When correcting or affirming, cite the specific Source URL from the CONTEXT.

7. **Citation Format.** When citing any case, always format it correctly: case caption in *italics* (e.g., *Smith v. Jones*) followed by the full reporter reference from the blog post (e.g., 123 A.D.3d 456 [1st Dept 2014]).

Tone: Firm, intellectually rigorous, Socratic, but encouraging.`;
    }

    // Prepare API messages: system prompt + full conversation history
    const apiMessages = [
        { role: "system", content: systemMessage }
    ];

    // Add all previous conversation turns
    for (let i = 0; i < conversationHistory.length - 1; i++) {
        apiMessages.push(conversationHistory[i]);
    }

    // Inject the retrieved context into the latest user message
    apiMessages.push({
        role: "user",
        content: `CONTEXT:\n${contextText}\n\nUSER'S LATEST MESSAGE: ${latestUserMessage}`
    });

    const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: apiMessages
    });

    console.log("\n--- ATTORNEY MALPRACTICE DIAGNOSTIC ---");
    console.log(response.choices[0].message.content);

    return {
        answer: response.choices[0].message.content,
        sources: contextChunks
    };
}

// Part 3: Test Run (Commented out for export)
// answerUserQuestion("What happens if my lawyer misses the statute of limitations in New York?");