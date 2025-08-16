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
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ====== Load allowed store tags ======
let allowedTags = [];
try {
  allowedTags = require('./tags_unique.json'); // JSON array of strings
  if (!Array.isArray(allowedTags)) allowedTags = [];
} catch (e) {
  console.warn('⚠️ Could not load tags_unique.json. Tag links will be disabled.', e?.message || e);
  allowedTags = [];
}

// ====== Tag link builder (choose /all or /nutritional-supplements) ======
const TAG_BASE_COLLECTION = process.env.TAG_BASE_COLLECTION || 'all';
const TAG_BASE_URL = `https://shop.healthandlight.com/collections/${TAG_BASE_COLLECTION}?filter.p.tag=`;
const makeTagLink = (t) => TAG_BASE_URL + encodeURIComponent(t);

// ====== Helpers for tag extraction from the model reply ======
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function extractTagsFrom(text) {
  if (!text || !allowedTags.length) return [];
  const hits = new Set();
  for (const raw of allowedTags) {
    let pat = escapeRegex(raw)
      .replace(/\\&/g, '(?:&|and)')   // & vs and
      .replace(/\\-/g, '[- ]?');     // hyphen vs space
    const re = new RegExp(`(?:^|[^\\w])${pat}(?=[^\\w]|$)`, 'i');
    if (re.test(text)) hits.add(raw);
  }
  return [...hits];
}

// ====== Dynamic model selection ======
let selectedModel = 'gpt-4o';
(async () => {
  try {
    const models = await openai.models.list();
    const sorted = models.data
      .filter(m => m.id.startsWith('gpt-') && (m.id.includes('turbo') || m.id.includes('gpt-4o')))
      .sort((a,b) => {
        const score = (id) => (id.includes('gpt-4o') ? 100 : (id.match(/gpt-(\d+(\.\d+)?)/)?.[1] ?? 0));
        return score(b.id) - score(a.id);
      });
    if (sorted.length) selectedModel = sorted[0].id;
    else console.warn('⚠️ No eligible GPT models found, using fallback gpt-4o.');
    console.log(`✅ Auto-selected model: ${selectedModel}`);
  } catch (err) {
    console.error('❌ Failed to fetch models:', err?.message || err);
  }
})();

// ====== System prompt ======
const SYSTEM_PROMPT = {
  role: 'system',
  content: `You are a warm, professional AI wellness advisor for Health & Light Institute.

CORE RULES
- NEVER invent service or product names.
- Prefer what actually exists at https://shop.healthandlight.com.
- When talking about Products or Services, DO NOT list category names verbatim in bullets.
- Instead, offer advice relevant to their stated condition or inquiry plus a SINGLE link to the relevant FILTERED collection:
  • Services: https://shop.healthandlight.com/collections/services?filter.p.tag=<TAG>
  • Products: https://shop.healthandlight.com/collections/nutritional-supplements?filter.p.tag=<TAG>
  Replace <TAG> with the user’s topic (e.g., Anxiety, Sleep, Digestion). If no suitable tag exists, say so and offer the nearest related tag that does exist.

FOLLOW-UPS
- For follow-up questions in the same chat, do not repeat empathy already expressed. Move straight to the next helpful step unless the user introduces new emotional content.

STYLE / FORMAT
- Use clear headings and bullets. Exactly these sections, if relevant:
  **Services** – one sentence and the single filtered Services link.
  **Nutritional Supplements** – one sentence and the single filtered Supplements link.
  **Lifestyle & Diet** – include grounded dietary and holistic lifestyle suggestions.

SAFETY / ACCURACY
- If there is no direct offering for a request, say so plainly and suggest the nearest relevant internal category link (filtered by tag).
- Include links only to our domain. No external claims, no affiliate suggestions unless the user explicitly asks.
`
};

// Backward-compat shim so any lingering calls won’t crash
function buildSystemPrompt() {
  return SYSTEM_PROMPT.content;
}

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

    const systemMsg = { role: 'system', content: buildSystemPrompt() };
    const fullMessages = [
      systemMsg,
      ...(Array.isArray(messages) ? messages.filter(m => m.role !== 'system') : [])
    ];

    const chatCompletion = await openai.chat.completions.create({
      model: selectedModel,
      messages: fullMessages,
    });

    let reply = chatCompletion.choices?.[0]?.message?.content || '';

    // Append "Shop by category" links if tags appear in the reply
    const MAX_TAG_LINKS = 8;
    const tagsFound = extractTagsFrom(reply).slice(0, MAX_TAG_LINKS);
    if (tagsFound.length) {
      const links = tagsFound
        .sort((a,b) => a.localeCompare(b))
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

// ====== Start server ======
app.listen(port, () => {
  console.log(`✅ Server listening on port ${port}`);
});
