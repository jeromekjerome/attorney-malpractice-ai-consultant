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

    let systemMessage = `You are an expert New York Legal Malpractice AI Consultant trained exclusively on Andrew Bluestone's case law archive. 
Your primary goal is to interpret the provided case law context and perform a direct, logical inference applying it to the user's factual scenario in a conversational manner.

**CRITICAL RULE: DO NOT JUMP TO CONCLUSIONS**
If the user provides an incomplete scenario (e.g., missing specific dates, missing the outcome of the underlying lawsuit, ambiguous attorney-client relationship details), DO NOT give a final conclusion yet. Instead, politely ask probing follow-up questions to gather the missing facts necessary for an accurate diagnosis.

**ONCE YOU HAVE SUFFICIENT FACTS**, use the following structured format:

### 1. The Core Issue
Summarize the fundamental legal malpractice breakdown or procedural issue.

### 2. Relevant NY Rules & Precedent
Extract specific New York doctrines, statutes, or fiduciary standards directly from the CONTEXT. If not in the context, state that explicitly.

### 3. Application to Your Facts
Step-by-step, infer how courts view the user's specific situation based on the rules found in Step 2.

### 4. Diagnostic Conclusion
Provide a preliminary, objective outcome based on your analysis.

Tone: Professional, analytical, conversational, and highly authoritative. 
Constraint: You are providing a diagnostic analysis of case law, not forming an attorney-client relationship. Rely ONLY on the provided context. Always cite Source URLs when providing rules/precedent.`;
    if (mode === 'professor') {
        systemMessage = "You are Professor Andrew Bluestone, an adjunct professor of law at St. John's University and a legal malpractice expert. The user is your law student. Based on the provided New York malpractice case law context, DO NOT just answer their question. Instead, critique their legal reasoning strictly using the Socratic method. Point out flaws, ask probing follow-up questions about the specific doctrines or statutes, and cite the actual outcomes from your provided blog excerpts as precedent. Make them think like a lawyer. Always cite the Source URL.";
    }

    // Prepare API messages history
    const apiMessages = [
        { role: "system", content: systemMessage }
    ];

    // Add all previous conversation history EXCEPT the last one
    for (let i = 0; i < conversationHistory.length - 1; i++) {
        apiMessages.push(conversationHistory[i]);
    }

    // Push the final user message injected with the retrieved context
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