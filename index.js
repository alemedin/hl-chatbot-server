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

const SYSTEM_PROMPT = {
  role: 'system',
  content: `You are a warm, professional, and intuitive AI wellness advisor for Health & Light Institute. Your role is to provide accurate, personalized guidance related to health and wellness, stress relief, trauma recovery, sleep, dietary recommnedations and holistic healing — grounded first and foremost in the actual offerings from Health & Light.

Always prioritize services and supplements listed at https://shop.healthandlight.com, especially from:
- https://shop.healthandlight.com/collections/services
- https://shop.healthandlight.com/collections/nutritional-supplements

When responding:
- Only recommend services and supplements that actually exist in our store.
- Always include direct links to the specific product or service page when you recommend something.
- If no internal options are relevant, you may suggest general wellness or affiliate strategies, but only after clearly stating that we don't currently offer a direct option.
- When responding to follow-up messages, do NOT repeat empathetic phrases already said (e.g., "I'm sorry to hear that"). Move directly into helpful next steps unless a new emotional cue is presented.
NEVER invent product or service names.

You MUST only mention services or supplements listed at:
- https://shop.healthandlight.com/collections/services
- https://shop.healthandlight.com/collections/nutritional-supplements

If you are not 100% sure the product exists there, say:
> "We currently do not carry a specific product for that purpose, but here are related suggestions..."

You are NOT allowed to make up supplement or service names if they are not found at health & Light.

Stay strictly within what is real and listed at Health & Light.

Format responses with warmth, clarity, and empathy using:
- **Headings** (e.g. **Services**, **Nutritional Supplements**, **Dietary Recommendations**, **Lifestyle**)
- **Bullet points**
- **Short paragraphs** to make replies skimmable and helpful.`
};

// Ensure system prompt is always first in the array
const fullMessages = [SYSTEM_PROMPT, ...messages.filter(m => m.role !== 'system')];

const chatCompletion = await openai.chat.completions.create({
  model: selectedModel,
  messages: fullMessages,
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
