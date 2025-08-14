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

// Root endpoint for status check
app.get('/', (req, res) => {
  res.send('🚀 Chatbot backend is live and running.');
});

// POST /chat
app.post('/chat', async (req, res) => {
  try {
    const { messages } = req.body;

    // Dynamically fetch available models and use the most capable one
    const models = await openai.models.list();
    const sortedModels = models.data
      .filter((m) => m.id.startsWith('gpt-') && m.id.includes('turbo') || m.id.includes('gpt-4o'))
      .sort((a, b) => {
        const extractVersion = (id) => {
          if (id.includes('gpt-4o')) return 100; // force 4o to top
          const match = id.match(/gpt-(\d+(\.\d+)?)/);
          return match ? parseFloat(match[1]) : 0;
        };
        return extractVersion(b.id) - extractVersion(a.id);
      });

    const selectedModel = sortedModels[0]?.id || 'gpt-4o';
    console.log(`💡 Using model: ${selectedModel}`);

    const chatCompletion = await openai.chat.completions.create({
      model: selectedModel,
      messages: messages,
    });

    const reply = chatCompletion.choices[0].message.content;
    res.json({ reply });
  } catch (error) {
    console.error('❌ Error:', error.message || error);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.listen(port, () => {
  console.log(`✅ Server listening on port ${port}`);
});
