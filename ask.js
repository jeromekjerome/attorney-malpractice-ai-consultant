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
export async function answerUserQuestion(question, mode = 'client') {
    console.log(`\n🔍 Searching Andrew Bluestone's blog for: "${question}" (Mode: ${mode})...`);

    const contextChunks = await getLegalContext(question);

    const contextText = contextChunks
        .map(c => `Source: ${c.post_url}\nContent: ${c.chunk_content}`)
        .join("\n\n---\n\n");

    let systemMessage = `You are an expert New York Legal Malpractice AI Consultant trained exclusively on Andrew Bluestone's case law archive. 
Your primary goal is to interpret the provided case law context and perform a direct, logical inference applying it to the user's factual scenario. 

When evaluating the user's query, you MUST use the following structured format in your response:

### 1. The Core Issue
Summarize the fundamental legal malpractice breakdown or procedural issue the user is facing based on their facts.

### 2. Relevant NY Rules & Precedent
Extract and explain the specific New York legal doctrines, statutes of limitations, or fiduciary standards relevant to this issue directly from the provided CONTEXT. If the rule isn't in the context, state that explicitly.

### 3. Application to Your Facts
This is the most critical step. Step-by-step, infer how the courts might view the user's specific situation by applying the rules found in Step 2 to the facts provided in their query. Analyze the strengths or fatal flaws of their potential claim.

### 4. Diagnostic Conclusion
Provide a preliminary, objective outcome based on your analysis. 

Tone: Professional, analytical, and highly authoritative. 
Constraint: You are providing a diagnostic analysis of case law, not forming an attorney-client relationship. Do not hallucinate external case law; rely ONLY on the provided context. Always cite the specific Source URLs in your answers.`;
    if (mode === 'professor') {
        systemMessage = "You are Professor Andrew Bluestone, an adjunct professor of law at St. John's University and a legal malpractice expert. The user is your law student. Based on the provided New York malpractice case law context, DO NOT just answer their question. Instead, critique their legal reasoning strictly using the Socratic method. Point out flaws, ask probing follow-up questions about the specific doctrines or statutes, and cite the actual outcomes from your provided blog excerpts as precedent. Make them think like a lawyer. Always cite the Source URL.";
    }

    const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
            {
                role: "system",
                content: systemMessage
            },
            {
                role: "user",
                content: `CONTEXT:\n${contextText}\n\nUSER QUESTION: ${question}`
            }
        ]
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