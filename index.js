// index.js
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
require('dotenv').config();
const { OpenAI } = require('openai');

// ====== App setup ======
const app = express();
const port = process.env.PORT || 10000;

app.use(cors({ origin: '*' }));
app.use(bodyParser.json());

// ====== OpenAI client ======
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ====== Load allowed store tags ======
let allowedTags = [];
try {
  // This must exist in your repo root (as you uploaded): tags_unique.json
  allowedTags = require('./tags_unique.json'); // JSON array of strings
  if (!Array.isArray(allowedTags)) allowedTags = [];
} catch (e) {
  console.warn('⚠️ Could not load tags_unique.json. Tag links will be disabled.', e?.message || e);
  allowedTags = [];
}

// ====== Tag link builder (choose /all or /nutritional-supplements) ======
const TAG_BASE_COLLECTION = process.env.TAG_BASE_COLLECTION || 'all';
// If you prefer supplements-only, set TAG_BASE_COLLECTION="nutritional-supplements" in Render env.
const TAG_BASE_URL = `https://shop.healthandlight.com/collections/${TAG_BASE_COLLECTION}?filter.p.tag=`;
const makeTagLink = (t) => TAG_BASE_URL + encodeURIComponent(t);

// ====== Helpers for tag extraction from the model reply ======
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function extractTagsFrom(text) {
  if (!text || !allowedTags.length) return [];
  const hits = new Set();
  for (const raw of allowedTags) {
    // Flexible matching:
    // - "&" or "and"
    // - "-" or space
    let pat = escapeRegex(raw);
    pat = pat.replace(/\\&/g, '(?:&|and)');
    pat = pat.replace(/\\-/g, '[- ]?');

    // Looser boundaries so punctuation doesn’t break matches
    const re = new RegExp(`(?:^|[^\\w])${pat}(?=[^\\w]|$)`, 'i');
    if (re.test(text)) hits.add(raw);
  }
  return [...hits];
}

// ====== Dynamic model selection ======
let selectedModel = 'gpt-4o'; // Fallback default
(async () => {
  try {
    const models = await openai.models.list();
    const sorted = models.data
      .filter((m) => m.id.startsWith('gpt-') && (m.id.includes('turbo') || m.id.includes('gpt-4o')))
      .sort((a, b) => {
        const v = (id) => {
          if (id.includes('gpt-4o')) return 100; // prioritize 4o family
          const m = id.match(/gpt-(\d+(\.\d+)?)/);
          return m ? parseFloat(m[1]) : 0;
        };
        return v(b.id) - v(a.id);
      });
    if (sorted.length) {
      selectedModel = sorted[0].id;
      console.log(`✅ Auto-selected model: ${selectedModel}`);
    } else {
      console.warn('⚠️ No eligible GPT models found, using fallback gpt-4o.');
    }
  } catch (err) {
    console.error('❌ Failed to fetch models:', err?.message || err);
  }
})();

// ====== Build the system prompt (inject your tag list so model uses them verbatim) ======
const buildSystemPrompt = () => {
  const tagListForPrompt = allowedTags.length ? `\n\nWhen referencing categories, prefer using these exact store tag names (verbatim) when appropriate: ${allowedTags.join(', ')}.` : '';
  return `You are a warm, professional, and intuitive AI wellness advisor for Health & Light Institute.

Your role: provide accurate, personalized guidance related to health & wellness, stress relief, trauma recovery, sleep, dietary recommendations, and holistic healing — grounded first and foremost in the actual offerings from Health & Light.

Always prioritize services and supplements listed at:
- https://shop.healthandlight.com/collections/services
- https://shop.healthandlight.com/collections/nutritional-supplements

Rules:
- Only recommend services and supplements that actually exist in our store.
- Always include direct links to the specific product or service page when you recommend something. If you reference a category (e.g., “Sleep”, “Probiotics”), write the exact category/tag name so links can be attached.
- If no internal options are relevant, you may suggest general wellness or affiliate strategies, but only after clearly stating that we don't currently offer a direct option.
- When responding to follow-ups, do NOT repeat empathy already expressed. Move to helpful next steps unless a new emotional cue appears.
- NEVER invent product or service names. If unsure the item exists, say: "We currently do not carry a specific product for that purpose, but here are related suggestions..."

Format with warmth, clarity, and empathy using:
- **Headings** (e.g. **Services**, **Nutritional Supplements**, **Dietary Recommendations**, **Lifestyle**)
- **Bullet points**
- **Short paragraphs** for skimmability.${tagListForPrompt}
`;
};

// ====== Root endpoint ======
app.get('/', (_req, res) => {
  res.send(
    `🚀 Chatbot backend is live.<br>` +
      `🤖 Model: <strong>${selectedModel}</strong><br>` +
      `🏷️ Tags loaded: <strong>${allowedTags.length}</strong> (base: /collections/${TAG_BASE_COLLECTION})`
  );
});

// ====== Debug tags ======
app.get('/debug/tags', (_req, res) => {
  res.json({ count: allowedTags.length, sample: allowedTags.slice(0, 12) });
});

// ====== Chat endpoint ======
app.post('/chat', async (req, res) => {
  try {
    const { messages } = req.body;
    const SYSTEM_PROMPT = { role: 'system', content: buildSystemPrompt() };

    // Ensure system prompt is first, and don't allow other system prompts to sneak in
    const fullMessages = [SYSTEM_PROMPT, ...(Array.isArray(messages) ? messages.filter((m) => m.role !== 'system') : [])];

    const chatCompletion = await openai.chat.completions.create({
      model: selectedModel,
      messages: fullMessages,
    });

    let reply = chatCompletion.choices?.[0]?.message?.content || '';

    // === Post-process: add Shop-by-category links when tags are mentioned ===
    const MAX_TAG_LINKS = 8; // keep it tidy
    const tagsFound = extractTagsFrom(reply).slice(0, MAX_TAG_LINKS);

    if (tagsFound.length) {
      const links = tagsFound
        .sort((a, b) => a.localeCompare(b))
        .map((t) => `- [${t}](${makeTagLink(t)})`)
        .join('\n');

      reply += `\n\n**Shop by category:**\n${links}`;
    }

    res.json({ reply });
  } catch (error) {
    console.error('❌ Chat error:', error?.message || error);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ====== Start server ======
app.listen(port, () => {
  console.log(`✅ Server listening on port ${port}`);
});
