import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import OpenAI from 'openai';

const sql = neon(process.env.DATABASE_URL);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const COURTLISTENER_TOKEN = process.env.COURTLISTENER_TOKEN;

// Part 0: Live Citator (Shepardizing via CourtListener)
async function shepardizeCitations(text) {
    if (!COURTLISTENER_TOKEN) {
        console.warn('⚠️  No COURTLISTENER_TOKEN set — skipping citation verification.');
        return { annotatedText: text, citationsFound: [] };
    }

    try {
        const formData = new URLSearchParams();
        formData.append('text', text);

        const res = await fetch('https://www.courtlistener.com/api/rest/v4/citation-lookup/', {
            method: 'POST',
            headers: {
                'Authorization': `Token ${COURTLISTENER_TOKEN}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: formData.toString()
        });

        if (!res.ok) {
            console.error('CourtListener API error:', res.status);
            return { annotatedText: text, citationsFound: [] };
        }

        const citations = await res.json();
        console.log(`\n📋 CourtListener found ${citations.length} citation(s) in the AI response.`);

        // Annotate the text by replacing each found citation with a verified/unverified badge
        // We process in reverse order so string indices stay valid
        let annotated = text;
        const verified = [];
        const unverified = [];

        // Sort by start_index descending so replacements don't shift indices
        const sorted = [...citations].sort((a, b) => b.start_index - a.start_index);

        for (const cite of sorted) {
            const start = cite.start_index;
            const end = cite.end_index;
            const citeText = cite.citation;

            if (cite.status === 200 && cite.clusters && cite.clusters.length > 0) {
                const cl = cite.clusters[0];
                const url = `https://www.courtlistener.com${cl.absolute_url || ''}`;
                const replacement = `${citeText} [✅ Verified](${url})`;
                annotated = annotated.substring(0, start) + replacement + annotated.substring(end);
                verified.push(citeText);
            } else if (cite.status === 404) {
                // Aggressive removal: Identify the case name and any trailing brackets
                let s = start;
                let e = end;
                const before = annotated.substring(0, s);
                
                // 1. Look for italics: *Case Name*, 
                const italicMatch = before.match(/\*([^*]*\b(?:v\.?|vs\.?)\b[^*]*)\*[, ]+\s*$/i);
                // 2. Look for non-italicized "Plaintiff v Defendant" pattern
                const plainMatch = before.match(/(?:[A-Z][\w'.,& ]+ \b(?:v\.?|vs\.?)\b [A-Z][\w'.,& ]+)[, ]+\s*$/i);
                
                if (italicMatch) {
                    s -= italicMatch[0].length;
                } else if (plainMatch) {
                    s -= plainMatch[0].length;
                }

                const after = annotated.substring(e);
                // Look for year/reporter info in brackets after citation: [1st Dept 2014]
                const bracketMatch = after.match(/^[, ]*\s*\[[^\]]+\]/);
                if (bracketMatch) {
                    e += bracketMatch[0].length;
                }
                
                // Final check: if we left a trailing "(see " or just "("
                let resultBefore = annotated.substring(0, s).trimEnd();
                if (resultBefore.endsWith("(see") || resultBefore.endsWith(" (see")) {
                    resultBefore = resultBefore.substring(0, resultBefore.length - 4).trimEnd();
                } else if (resultBefore.endsWith("(")) {
                    // Try to also remove the closing parenthesis if it exists immediately after
                    if (annotated.substring(e).trimStart().startsWith(")")) {
                        const nextParen = annotated.indexOf(")", e);
                        e = nextParen + 1;
                        resultBefore = resultBefore.substring(0, resultBefore.length - 1).trimEnd();
                    }
                }

                annotated = resultBefore + annotated.substring(e);
                unverified.push(citeText);
            }
        }

        if (verified.length > 0) console.log('  ✅ Verified:', verified);
        if (unverified.length > 0) console.log('  ⚠️  Could not verify (and stripped):', unverified);

        // --- SECONDARY REPAIR & CLEANUP: Orphaned Case Names ---
        // Look for case name patterns (Italicized or plain P v D) that aren't followed by a Verified badge.
        // We will try to look these up by name on CourtListener before giving up and stripping them.
        
        // Match case names that ARE NOT followed by a verified badge (allowing for an intervening reporter citation)
        // We include a precursor match for "in " or "see " so we can clean those up too
        const orphanedRegex = /(\b(?:in|see)\s*)?(\*?[A-Z][\w'.,& ]+ \b(?:v\.?|vs\.?)\b [A-Z][\w'.,& ]+\*?)(?!\s*[, ]+(?:\d+\s+[A-Z.]+\d+\s*)?\[✅ Verified\])/gi;
        const matches = [...annotated.matchAll(orphanedRegex)];
        
        if (matches.length > 0) {
            console.log(`\n🔎 Attempting to repair ${matches.length} orphaned case name(s)...`);
            // We'll process these in reverse order to keep positions stable
            for (let i = matches.length - 1; i >= 0; i--) {
                const match = matches[i];
                const precursor = match[1] || '';
                const caseNameMatch = match[2];
                const caseName = caseNameMatch.replace(/\*/g, '').trim();
                const start = match.index;
                const end = start + match[0].length;

                try {
                    // Search CourtListener for the case name
                    // We REMOVE the court filter to allow finding non-NY cases as requested
                    const searchRes = await fetch(
                        `https://www.courtlistener.com/api/rest/v4/search/?q=name:(${encodeURIComponent(caseName)})&type=o&ordering=score`, 
                        { headers: { 'Authorization': `Token ${COURTLISTENER_TOKEN}` } }
                    );

                    if (searchRes.ok) {
                        const searchData = await searchRes.json();
                        // If we have potential candidates
                        if (searchData.count > 0) {
                            // Take top 3 results for evaluation
                            const candidates = searchData.results.slice(0, 3);
                            
                            // Use inference (LLM) to verify which search result (if any) is the correct match
                            const verificationPrompt = `You are a legal citation expert. I am trying to find the correct citation for a case mentioned in this snippet:
"${annotated.substring(Math.max(0, start - 200), Math.min(annotated.length, end + 200))}"

The case name mentioned is: "${caseName}"

Here are the top search results from CourtListener:
${candidates.map((c, idx) => `${idx + 1}. ${c.case_name} (${c.citation?.[0] || 'No citation'})`).join('\n')}

Does any of these results UNAMBIGUOUSLY match the case mentioned in the snippet? 
Respond ONLY with a JSON object: {"match_found": true, "index": 0} (where index is 0, 1, or 2) or {"match_found": false}.`;

                            const evalResponse = await openai.chat.completions.create({
                                model: "gpt-4o-mini",
                                messages: [{ role: "system", content: "You are a precise legal research assistant." }, { role: "user", content: verificationPrompt }],
                                response_format: { type: "json_object" }
                            });

                            const evalResult = JSON.parse(evalResponse.choices[0].message.content);

                            if (evalResult.match_found && candidates[evalResult.index]) {
                                const result = candidates[evalResult.index];
                                const reporter = result.citation && result.citation.length > 0 ? result.citation[0] : null;
                                const clUrl = `https://www.courtlistener.com${result.absolute_url}`;
                                
                                if (reporter) {
                                    console.log(`  ✨ Repaired via inference: "${caseName}" -> ${reporter}`);
                                    const replacement = `*${caseName}*, ${reporter} [✅ Verified](${clUrl})`;
                                    annotated = annotated.substring(0, start) + replacement + annotated.substring(end);
                                    continue;
                                }
                            }
                        }
                    }
                } catch (err) {
                    console.error(`  ❌ Repair failed for "${caseName}":`, err.message);
                }

                // If repair failed or was ambiguous, strip it as per previous strict rule
                console.log(`  🗑️  Stripping unrepairable case: "${caseName}"`);
                let s = start;
                let e = end;
                const before = annotated.substring(0, s);
                const after = annotated.substring(e);

                // Check for year/reporter info in brackets after citation
                const bracketMatch = after.match(/^[, ]*\s*\(?[^)]+\)?[, ]*\s*\[[^\]]+\]/);
                if (bracketMatch) e += bracketMatch[0].length;
                
                let resultBefore = before.trimEnd();
                if (resultBefore.endsWith("(see") || resultBefore.endsWith(" (see")) {
                    resultBefore = resultBefore.substring(0, resultBefore.length - 4).trimEnd();
                } else if (resultBefore.endsWith("(")) {
                    // Try to also remove the closing parenthesis if it exists immediately after
                    if (annotated.substring(e).trimStart().startsWith(")")) {
                        const nextParen = annotated.indexOf(")", e);
                        e = nextParen + 1;
                        resultBefore = resultBefore.substring(0, resultBefore.length - 1).trimEnd();
                    }
                }
                annotated = resultBefore + annotated.substring(e);
            }
        }

        // 3. Final cleanup for any resulting debris
        annotated = annotated.replace(/\(\s*[, ]+(?:and other sources|and sources)?\s*\)/gi, "");
        annotated = annotated.replace(/\(\s*[, ]+\s*\)/g, "");
        annotated = annotated.replace(/\*\*\s*\[[^\]]+\]/g, ""); // Clean up orphaned bold markers and trailing court info
        annotated = annotated.replace(/\s+✅ Verified\* /g, " [✅ Verified] "); // Fix the weird badge/asterisk glitch
        annotated = annotated.replace(/ established in\b/gi, " established"); // Clean up leading prepositions
        annotated = annotated.replace(/([.?!])\s*[),]\s*/g, "$1 "); // Clean up rogue closing punctuation

        return { annotatedText: annotated.trim(), citationsFound: citations };

    } catch (err) {
        console.error('CourtListener lookup failed:', err.message);
        return { annotatedText: text, citationsFound: [] };
    }
}

// Part 0b: Forward Citation Profiler
// For each verified case the AI cites, find newer opinions that also cited it.
// This surfaces whether the legal principles cited have been recently reaffirmed,
// distinguished, or potentially superseded by more recent case law.
async function forwardCiteProfile(citations) {
    if (!COURTLISTENER_TOKEN || !citations || citations.length === 0) return [];

    const clHeaders = {
        'Authorization': `Token ${COURTLISTENER_TOKEN}`,
        'Content-Type': 'application/json'
    };

    // Only process verified citations that have a cluster with a sub-opinion
    const verified = citations.filter(c => c.status === 200 && c.clusters?.length > 0);

    const profiles = await Promise.all(verified.map(async (cite) => {
        try {
            const cluster = cite.clusters[0];
            const clusterUrl = cluster.resource_uri; // e.g. /api/rest/v4/clusters/2115637/
            const clusterId = clusterUrl?.match(/(\d+)\/?$/)?.[1];
            if (!clusterId) return null;

            // Step 1: Get the primary opinion ID for this cluster
            const clusterRes = await fetch(`https://www.courtlistener.com/api/rest/v4/clusters/${clusterId}/`, {
                headers: clHeaders
            });
            if (!clusterRes.ok) return null;
            const clusterData = await clusterRes.json();

            // sub_opinions is an array of opinion URLs — grab the first
            const opinionUrl = clusterData.sub_opinions?.[0];
            const opinionId = opinionUrl?.match(/(\d+)\/?$/)?.[1];
            if (!opinionId) return null;

            const originalDate = clusterData.date_filed || '1900-01-01';

            // Step 2: Find the 3 most recent opinions that cite this one
            const forwardRes = await fetch(
                `https://www.courtlistener.com/api/rest/v4/opinions-cited/?cited_opinion=${opinionId}&ordering=-id&page_size=5`,
                { headers: clHeaders }
            );
            if (!forwardRes.ok) return null;
            const forwardData = await forwardRes.json();

            if (!forwardData.results || forwardData.results.length === 0) {
                return { citation: cite.citation, caseName: cluster.case_name, originalDate, recentCiting: [], totalCiting: 0 };
            }

            // Step 3: Enrich the top forward citations with case metadata
            const topForward = forwardData.results.slice(0, 3);
            const enriched = await Promise.all(topForward.map(async (fc) => {
                try {
                    const citingOpinionId = fc.citing_opinion.match(/(\d+)\/?$/)?.[1];
                    if (!citingOpinionId) return null;

                    // Get the cluster for the citing opinion
                    const opRes = await fetch(`https://www.courtlistener.com/api/rest/v4/opinions/${citingOpinionId}/`, {
                        headers: clHeaders
                    });
                    if (!opRes.ok) return null;
                    const opData = await opRes.json();

                    const citingClusterUrl = opData.cluster;
                    const citingClusterId = citingClusterUrl?.match(/(\d+)\/?$/)?.[1];
                    if (!citingClusterId) return null;

                    const citingClusterRes = await fetch(`https://www.courtlistener.com/api/rest/v4/clusters/${citingClusterId}/`, {
                        headers: clHeaders
                    });
                    if (!citingClusterRes.ok) return null;
                    const citingCluster = await citingClusterRes.json();

                    return {
                        caseName: citingCluster.case_name || 'Unknown',
                        dateFiled: citingCluster.date_filed || 'Unknown',
                        url: `https://www.courtlistener.com${citingCluster.absolute_url || ''}`,
                        depth: fc.depth // how many times this case cited the original
                    };
                } catch { return null; }
            }));

            return {
                citation: cite.citation,
                caseName: cluster.case_name,
                originalDate,
                clUrl: `https://www.courtlistener.com${cluster.absolute_url}`,
                totalCiting: forwardData.count,
                recentCiting: enriched.filter(Boolean)
            };
        } catch (err) {
            console.error(`Forward cite error for ${cite.citation}:`, err.message);
            return null;
        }
    }));

    return profiles.filter(Boolean);
}

// Part 0c: Removed case extraction

// Part 1: The Retrieval Logic (Finds the best chunks)
async function getLegalContext(userQuery) {
    // 1. Fast Vector Search for Top 20 Candidates
    const embeddingResponse = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: userQuery,
    });
    const queryVector = embeddingResponse.data[0].embedding;

    const initialResults = await sql`
        SELECT post_url, chunk_content, 
        1 - (embedding <=> ${JSON.stringify(queryVector)}) AS similarity
        FROM bluestone_blog_chunks
        ORDER BY similarity DESC
        LIMIT 20;
    `;

    // 2. Filter Top 20 Candidates for those containing complete legal citations
    // We look for: *Case Name*, 123 A.D.3d 456
    // Or plain Name v Name, 123 A.D.3d 456
    const citeRegex = /(?:\*?[A-Z][\w'.,& ]+ \b(?:v\.?|vs\.?)\b [A-Z][\w'.,& ]+\*?)[, ]+\d+\s+[A-Z. ]+\d+/i;
    
    const filteredResults = initialResults.filter(c => {
        const hasCite = citeRegex.test(c.chunk_content);
        return hasCite;
    });

    console.log(`📋 Search found ${initialResults.length} candidates. ${filteredResults.length} contains complete citations.`);

    if (filteredResults.length === 0) {
        console.warn("⚠️ No chunks with complete citations found. Falling back to top vector results.");
        return initialResults.slice(0, 3);
    }

    // 3. LLM Re-ranking to find the actual Top 3 most relevant from the citations
    console.log(`🧠 Re-ranking top ${filteredResults.length} cited chunks via LLM...`);
    
    const prompt = `You are a legal research expert. Your job is to select the 3 most relevant legal blog post chunks that contain authoritative New York case law and provide the best analysis for the user's situation.
    
USER SITUATION: "${userQuery}"

CANDIDATE CHUNKS (All contain citations):
${filteredResults.map((c, i) => `--- [ID: ${i}] ---\n${c.chunk_content}`).join("\n\n")}

Return a JSON object with a single key "top_indices" containing an array of integers representing the IDs of the 3 most relevant chunks, ordered from most to least relevant. Example: {"top_indices": [2, 0, 4]}`;

    try {
        const rerankResponse = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: prompt }],
            response_format: { type: "json_object" }
        });
        
        const result = JSON.parse(rerankResponse.choices[0].message.content);
        
        if (result.top_indices && Array.isArray(result.top_indices)) {
            const rankedChunks = result.top_indices
                .map(id => filteredResults[parseInt(id)])
                .filter(Boolean)
                .slice(0, 3);
                
            if (rankedChunks.length > 0) {
                console.log(`✅ Re-ranking successful. Selected ${rankedChunks.length} chunks.`);
                return rankedChunks.map(c => {
                    const citations = c.chunk_content.match(new RegExp(citeRegex, 'gi')) || [];
                    return { ...c, citations: [...new Set(citations)] };
                });
            }
        }
    } catch (err) {
        console.error("⚠️ Re-ranking failed:", err.message);
    }

    // Fallback: return top 3 from filtered search
    return filteredResults.slice(0, 3).map(c => {
        const citations = c.chunk_content.match(new RegExp(citeRegex, 'gi')) || [];
        return { ...c, citations: [...new Set(citations)] };
    });
}

// Part 2: The Answer Logic (Generates the response)
export async function answerUserQuestion(messages, mode = 'client') {
    // Determine if it's a first query or an ongoing conversation
    const isArray = Array.isArray(messages);
    const latestUserMessage = isArray ? messages[messages.length - 1].content : messages;
    const conversationHistory = isArray ? messages : [{ role: 'user', content: messages }];

    // Turn number = number of user messages so far (each full turn = user + assistant)
    const turnNumber = conversationHistory.filter(m => m.role === 'user').length;

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

**DIAGNOSTIC CONCLUSION RULES:**
1. If the Facts are **INCOMPLETE** (Turn ${turnNumber}): Ask ONE focused follow-up question. Do not refer to Andrew yet.
2. If the Facts are **SUFFICIENT** (Turn ${turnNumber}):
   - **Render a Final Conclusion.**
   - If viable: Strongly recommend contacting Andrew Bluestone at **(212) 791-5600**.
   - If the user is at Turn 3+ and the claim has merit, explicitly ask for the user's phone number so the office can reach out to them directly.

Tone: Professional, analytical, conversational, and highly authoritative. 
CITATION FORMAT: **STRICT REQUIREMENT.** You MUST NOT mention a case name unless you also provide its full reporter reference (e.g., *Smith v. Jones*, 123 A.D.3d 456). Format the caption in *italics* and the reporter reference as it appears in the source blog post.
Constraint: You are providing a diagnostic analysis of case law, not forming an attorney-client relationship. Rely ONLY on the provided context. Always cite Source URLs as clickable markdown links (e.g., [Source](url)) when providing rules/precedent. **Only include legal citations that appear in the CONTEXT.**`;

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

7. **Citation Format.** **STRICT REQUIREMENT.** Never mention a case name without its full reporter reference (e.g., *Smith v. Jones*, 123 A.D.3d 456 [1st Dept 2014]). **Only include legal citations that appear in the CONTEXT. Unverified citations or standalone case names without reporters will be automatically stripped.**

8. **Milestone Feedback (Turn ${turnNumber}):** ${turnNumber % 3 === 0 ? "You have reached a milestone in this seminar. Before posing your next question, provide a brief, professional assessment of the student's analytical progress. Highlight their strengths in handling the case law so far and pinpoint the specific doctrinal gaps they still need to bridge. After this assessment, transition to your next focused question." : "Continue the seminar with your next logical question based on the student's last response."}

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

    let rawAnswer = response.choices[0].message.content;

    // In case the model still tries to generate it from old conversations
    rawAnswer = rawAnswer.replace(/\n\n---\n> ⚖️ \*This analysis is for informational purposes only.*/g, "").trim();

    console.log("\n--- ATTORNEY MALPRACTICE DIAGNOSTIC ---");
    console.log(rawAnswer);

    // Run citation verification once
    const { annotatedText, citationsFound } = await shepardizeCitations(rawAnswer);
    
    // Run forward citation profiling based on found citations
    const forwardProfiles = await forwardCiteProfile(citationsFound);

    // Build the "Recent Precedent Update" section from forward citation data
    let precedentUpdate = '';
    if (forwardProfiles && forwardProfiles.length > 0) {
        precedentUpdate = '\n\n---\n### 📡 Recent Precedent Update\n*The following cases have recently cited the authorities used in this analysis:*\n\n';
        for (const profile of forwardProfiles) {
            precedentUpdate += `**[${profile.citation} — *${profile.caseName}*](${profile.clUrl})**`;
            precedentUpdate += ` (decided ${profile.originalDate} · cited by **${profile.totalCiting}** later opinions)\n`;
            if (profile.recentCiting.length > 0) {
                precedentUpdate += `*Most recent citing cases:*\n`;
                for (const rc of profile.recentCiting) {
                    const depth = rc.depth > 1 ? ` *(cited ${rc.depth}×)*` : '';
                    precedentUpdate += `- [*${rc.caseName}*](${rc.url}) — ${rc.dateFiled}${depth}\n`;
                }
            } else {
                precedentUpdate += `*No recent citing cases found in CourtListener.*\n`;
            }
            precedentUpdate += '\n';
        }
    }

    // Append disclaimer
    const disclaimer = `\n\n---\n> ⚖️ *This analysis is for informational purposes only. All citations have been cross-referenced with CourtListener's database, but should be independently verified via Westlaw or LexisNexis before relying on them in any legal proceeding.*`;

    return {
        answer: annotatedText + precedentUpdate + disclaimer,
        raw_answer: annotatedText + precedentUpdate,
        sources: contextChunks
    };
}

/**
 * checkViability
 * Uses GPT-4o-mini to determine if the user has a "colorable case" (viable malpractice claim)
 * based on the conversation history and the latest AI analysis.
 */
export async function checkViability(history, analysis) {
    const turnNumber = history.filter(m => m.role === 'user').length;
    
    const prompt = `You are a legal lead intake specialist for a New York malpractice firm.
Review the following conversation and the AI's diagnostic analysis.

CONVERSATION:
${history.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n')}

AI ANALYSIS:
${analysis}

Your task is to determine if this user has a "colorable" (prima facie) legal malpractice case in New York AND if we have enough information to justify an intake email.

CRITERIA FOR "COLORABLE":
- Existence of attorney-client relationship.
- Specific act of negligence (breach of duty).
- Proximate cause (but-for the negligence, the client would have prevailed).
- Actual damages.

CRITERIA FOR "INFORMATIONAL SUFFICIENCY" (Email Trigger):
1. Does the user provide enough facts to identify a potential malpractice event (e.g., missed deadline, settlement error, conflict)?
2. If the facts are broad or speculative (e.g., "my lawyer is bad"), set infoSufficient to false.
3. If the user provides a specific narrative (like the one in the special-cases test), set infoSufficient to true immediately.

Return ONLY a JSON object: {
  "isColorable": true/false, 
  "infoSufficient": true/false,
  "confidence": 0.0-1.0, 
  "reasoning": "one sentence"
}`;

    try {
        const resp = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: prompt }],
            response_format: { type: 'json_object' },
            temperature: 0
        });
        const result = JSON.parse(resp.choices[0].message.content);
        
        // Trigger if it's colorable AND we have enough to act on
        const shouldNotify = result.isColorable && result.infoSufficient;
        
        console.log(`📡 Lead Assessment: ${shouldNotify ? '🚀 NOTIFY' : '⏳ OBSERVE'} (Turn ${turnNumber}: ${result.reasoning})`);
        return shouldNotify;
    } catch (err) {
        console.error('Viability check failed:', err.message);
        return false;
    }
}


// Part 3: Test Run (Commented out for export)
// answerUserQuestion("What happens if my lawyer misses the statute of limitations in New York?");