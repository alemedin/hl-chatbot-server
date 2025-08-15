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

// Dynamically determine best model on startup
let selectedModel = 'gpt-4o'; // Fallback default
(async () => {
  try {
    const models = await openai.models.list();
    const sortedModels = models.data
      .filter((m) => m.id.startsWith('gpt-') && (m.id.includes('turbo') || m.id.includes('gpt-4o')))
      .sort((a, b) => {
        const extractVersion = (id) => {
          if (id.includes('gpt-4o')) return 100;
          const match = id.match(/gpt-(\d+(\.\d+)?)/);
          return match ? parseFloat(match[1]) : 0;
        };
        return extractVersion(b.id) - extractVersion(a.id);
      });

    if (sortedModels.length > 0) {
      selectedModel = sortedModels[0].id;
      console.log(`✅ Auto-selected model: ${selectedModel}`);
    } else {
      console.warn('⚠️ No eligible GPT models found, falling back to gpt-4o.');
    }
  } catch (err) {
    console.error('❌ Failed to fetch models:', err.message || err);
  }
})();

// Root endpoint – show model in use
app.get('/', (req, res) => {
  res.send(`🚀 Chatbot backend is live and running.<br>🤖 Using model: <strong>${selectedModel}</strong>`);
});

// POST /chat
app.post('/chat', async (req, res) => {
  try {
    const { messages } = req.body;

    const chatCompletion = await openai.chat.completions.create({
      model: selectedModel,
      messages,
    });

    const reply = chatCompletion.choices[0].message.content;
    res.json({ reply });
  } catch (error) {
    console.error('❌ Chat error:', error.message || error);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.listen(port, () => {
  console.log(`✅ Server listening on port ${port}`);
});
