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

// 🚀 Health check route
app.get('/', (req, res) => {
  res.send('🚀 Chatbot backend is live and running.');
});

// 🔁 Utility function to get best available chat model
let cachedModel = null;
async function getBestChatModel() {
  if (cachedModel) return cachedModel;

  const preferredOrder = [
    'gpt-5',
    'gpt-4.5',
    'gpt-4o',
    'gpt-4-turbo',
    'gpt-4',
    'gpt-3.5-turbo',
  ];

  try {
    const models = await openai.models.list();
    const available = models.data.map(m => m.id);
    for (const preferred of preferredOrder) {
      const match = available.find(m => m.startsWith(preferred));
      if (match) {
        cachedModel = match;
        console.log(`✅ Using best available model: ${cachedModel}`);
        return cachedModel;
      }
    }
  } catch (error) {
    console.error('⚠️ Failed to fetch model list:', error);
  }

  // Fallback
  cachedModel = 'gpt-4o';
  console.log(`⚠️ Falling back to: ${cachedModel}`);
  return cachedModel;
}

// 💬 Main chat endpoint
app.post('/chat', async (req, res) => {
  try {
    const { messages } = req.body;
    const model = await getBestChatModel();

    const chatCompletion = await openai.chat.completions.create({
      model,
      messages,
    });

    const reply = chatCompletion.choices[0].message.content;
    res.json({ reply });
  } catch (error) {
    console.error('❌ Error handling chat:', error);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
