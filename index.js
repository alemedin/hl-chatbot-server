import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import bodyParser from 'body-parser';
import { OpenAI } from 'openai';

dotenv.config();

const app = express();
const port = process.env.PORT || 10000;

app.use(cors());
app.use(bodyParser.json());

// Optional: homepage route
app.get('/', (req, res) => {
  res.send('Chatbot server is live and ready.');
});

// Initialize OpenAI with sk-proj key
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.post('/chat', async (req, res) => {
  const { messages } = req.body;

  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: 'Invalid messages format' });
  }

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages
    });

    res.json({ reply: completion.choices[0].message.content });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.response?.data?.error?.message || 'Unknown error' });
  }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
