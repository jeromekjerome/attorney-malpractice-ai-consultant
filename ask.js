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

    let systemMessage = "You are a legal malpractice diagnostic assistant. Use the provided blog excerpts from Andrew Bluestone to answer the user's question. If the answer isn't in the context, say you don't know. Always cite the Source URL.";
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