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
const SYSTEM_PROMPT = {
  role: 'system',
  content: `You are a warm, professional AI wellness advisor for Health & Light Institute.

CORE RULES
- NEVER invent service or product names.
- Prefer what actually exists at https://shop.healthandlight.com.
- When talking about Services or Supplements, DO NOT list category names.
- Instead, give one short sentence plus a SINGLE link to the relevant FILTERED collection:
  • Services: https://shop.healthandlight.com/collections/services?filter.p.tag=<TAG>
  • Supplements: https://shop.healthandlight.com/collections/nutritional-supplements?filter.p.tag=<TAG>
  Replace <TAG> with the user’s topic (e.g., Anxiety, Sleep, Digestion). If no suitable tag exists, say so and give the nearest related tag that does exist.

FOLLOW-UPS
- For follow-up questions in the same chat, do not repeat empathy already expressed. Move straight to the next helpful step unless the user introduces new emotional content.

STYLE / FORMAT
- Use clear headings and bullets. Exactly these sections, if relevant:
  **Services** – one sentence and the single filtered Services link.
  **Nutritional Supplements** – one sentence and the single filtered Supplements link.
  **Lifestyle & Diet** – include grounded dietary and holistic lifestyle suggestions.

SAFETY / ACCURACY
- If there is no direct offering for a request, say so plainly and suggest the nearest relevant internal category link (filtered by tag).
- Include links only to our domain. No external claims, no affiliate suggestions unless user explicitly asks.
`
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

    // Use the global SYSTEM_PROMPT you defined above. Do NOT redefine it here.
    const fullMessages = [
      SYSTEM_PROMPT,
      ...(Array.isArray(messages) ? messages.filter(m => m.role !== 'system') : [])
    ];

    const chatCompletion = await openai.chat.completions.create({
      model: selectedModel,
      messages: fullMessages,
    });

    let reply = chatCompletion.choices?.[0]?.message?.content || '';

    // === Post-process: add Shop-by-category links when tags are mentioned ===
    const MAX_TAG_LINKS = 8;
    const tagsFound = extractTagsFrom(reply).slice(0, MAX_TAG_LINKS);

    if (tagsFound.length) {
      const links = tagsFound
        .sort((a, b) => a.localeCompare(b))
        .map(t => `- [${t}](${makeTagLink(t)})`)
        .join('\n');

      reply += `\n\n**Shop by category:**\n${links}`;
    }

    res.json({ reply });
  } catch (error) {
    console.error('❌ Chat error:', error?.message || error);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});
