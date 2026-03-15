import 'dotenv/config';
import OpenAI from 'openai';
import { answerUserQuestion } from './ask.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// The persona the simulated user will adopt
const USER_PERSONA = `You are a distressed former client of a lawyer in New York. 
Your previous attorney missed a critical deadline to file an appeal for your medical malpractice case.
You are talking to an AI consultant. Provide short, concise answers (1-2 sentences). 
Do NOT give all the information at once. Only answer whatever specific question the AI consultant asks you.`;

async function runAutomatedTest() {
    console.log("🚀 Starting Automated 6-Turn Conversation Test...\n");
    console.log("=================================================");

    const messages = [];
    
    // Initial user message
    const initialMessage = "My lawyer blew the deadline on my med mal case. Am I screwed?";
    console.log(`\n👤 TEST USER [Turn 1]:`);
    console.log(initialMessage);
    messages.push({ role: 'user', content: initialMessage });

    let turn = 1;
    while (turn <= 6) {
        // 1. Get AI Consultant's Response
        console.log(`\n⏳ AI Consultant is thinking (Turn ${turn})...`);
        const result = await answerUserQuestion(messages, 'client');
        const aiAnswer = result.raw_answer || result.answer;
        
        console.log(`\n🤖 AI CONSULTANT [Turn ${turn}]:`);
        console.log("-----------------------------------------");
        console.log(aiAnswer);
        console.log("-----------------------------------------");
        
        // Add AI response to history
        messages.push({ role: 'assistant', content: aiAnswer });

        if (turn === 6) break; // Finished testing

        // 2. Generate Simulated User Response
        console.log(`\n⏳ Simulating User response for Turn ${turn + 1}...`);
        
        // Create messages array for the simulator model (which includes the persona and the conversation history so far)
        const simulatorMessages = [{ role: 'system', content: USER_PERSONA }, ...messages];
        
        const simResponse = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: simulatorMessages,
            temperature: 0.7
        });

        const userReply = simResponse.choices[0].message.content;
        
        console.log(`\n👤 TEST USER [Turn ${turn + 1}]:`);
        console.log(userReply);
        
        // Add user response to history
        messages.push({ role: 'user', content: userReply });
        turn++;
    }

    console.log("\n✅ Automated test complete!");
}

runAutomatedTest();
