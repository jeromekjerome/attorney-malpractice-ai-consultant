import express from 'express';
import cors from 'cors';
import { answerUserQuestion } from './ask.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serve frontend files

app.post('/api/ask', async (req, res) => {
    try {
        const { question, mode } = req.body;

        if (!question) {
            return res.status(400).json({ error: "Question is required." });
        }

        const result = await answerUserQuestion(question, mode);
        res.json(result);
    } catch (error) {
        console.error("Error processing question:", error);
        res.status(500).json({ error: "An error occurred while generating the diagnostic." });
    }
});

app.listen(PORT, () => {
    console.log(`\n🚀 Server is running on http://localhost:${PORT}`);
    console.log(`Navigate to http://localhost:${PORT} to view the frontend.\n`);
});
