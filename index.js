const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
require('dotenv').config();
const { OpenAI } = require('openai');

const app = express();
const port = process.env.PORT || 10000;

app.use(cors());
app.use(bodyParser.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 👇 ✅ Add this route to respond to GET requests to the root URL
app.get('/', (req, res) => {
  res.send('🚀 Chatbot backend is live and running.');
});

// Your POST /chat endpoint
app.post('/chat', async (req, res) => {
  try {
    const { messages } = req.body;

    const chatCompletion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: messages,
    });

    const reply = chatCompletion.choices[0].message.content;
    res.json({ reply });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
