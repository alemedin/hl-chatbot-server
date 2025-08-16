// index.js
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
require('dotenv').config();
const { OpenAI } = require('openai');

// ==== NEW: load your Shopify tag allow-list ==== //
const TAGS = require('./tags_unique.json'); // keep tags_unique.json in repo root
const TAGS_SET = new Set(TAGS.map(t => t.trim()));
const TAGS_MAP_LOWER = new Map(TAGS.map(t => [t.trim().toLowerCase(), t.trim()]));
const TAG_LINK_BASE = 'https://shop.healthandlight.com/collections/nutritional-supplements';

// ----------------------------------------------- //

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
      .filter(m => m.id.startsWith('gpt-') && (m.id.includes('turbo') || m.id.includes('gpt-4o')))
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

// Helper: convert [[Tag]] placeholders into links, but only if Tag is in allow-list
function linkifyAllowedTags(text) {
  return text.replace(/\[\[([^\]]+)\]\]/g, (m, rawTag) => {
    const normalized = rawTag.trim();
    const official = TAGS_SET.has(normalized)
      ? normalized
      : TAGS_MAP_LOWER.get(normalized.toLowerCase()); // allow case-insensitive match

    if (!official) {
      // Tag not allowed → remove brackets, keep plain text
      return normalized;
    }
    const url = `${TAG_LINK_BASE}?filter.p.tag=${encodeURIComponent(official)}`;
    return `[${official}](${url})`;
  });
}

// POST /chat
app.post('/chat', async (req, res) => {
  try {
    const { messages } = req.body;

    // Build the tag instruction text (short to avoid tokens)
    const TAG_INSTRUCTIONS =
      `Allowed category/tag list (use EXACT names, at most 3 per reply): ${TAGS.join(', ')}.\n` +
      `When you want to suggest a category, write it in double brackets like [[Probiotics]] or [[Sleep]]. ` +
      `Do NOT invent categories not in the list. The server will convert [[Tag]] into a link.`;

    const SYSTEM_PROMPT = {
      role: 'system',
      content: `You are a warm, professional, and intuitive AI wellness advisor for Health & Light Institute.
Your role is to provide accurate, personalized guidance related to health and wellness, stress relief, trauma recovery, sleep, dietary recommendations and holistic healing — grounded first and foremost in the actual offerings from Health & Light.

Always prioritize services and supplements listed at:
- https://shop.healthandlight.com/collections/services
- https://shop.healthandlight.com/collections/nutritional-supplements

Rules:
- Only recommend services and supplements that actually exist in our store.
- Always include direct links to the specific product or service page when you recommend something.
- If no internal options are relevant, suggest general wellness strategies only after clearly stating we don't have a direct option.
- For follow-up messages, do NOT repeat empathy already expressed unless a new emotional cue appears.
- NEVER invent product or service names.
- For supplement *categories*, use the provided tag list and output tags in [[double brackets]]. ${TAG_INSTRUCTIONS}

Tone & Format:
- Warmth, clarity, empathy.
- Use **Headings** (e.g. **Services**, **Nutritional Supplements**, **Dietary Recommendations**, **Lifestyle**),
  **bullet points**, and **short paragraphs**.`
    };

    // Ensure system prompt is always first in the array
    const fullMessages = [SYSTEM_PROMPT, ...messages.filter(m => m.role !== 'system')];

    const chatCompletion = await openai.chat.completions.create({
      model: selectedModel,
      messages: fullMessages,
    });

    let reply = chatCompletion.choices[0].message.content || '';
    // Post-process: convert [[Tag]] → link if in allow-list
    reply = linkifyAllowedTags(reply);

    res.json({ reply });
  } catch (error) {
    console.error('❌ Chat error:', error.message || error);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.listen(port, () => {
  console.log(`✅ Server listening on port ${port}`);
});
