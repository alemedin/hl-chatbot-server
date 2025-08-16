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
  // Ensure this file exists in your repo root
  allowedTags = require('./tags_unique.json'); // JSON array of strings
  if (!Array.isArray(allowedTags)) allowedTags = [];
} catch (e) {
  console.warn('⚠️ Could not load tags_unique.json. Tag links will be disabled.', e?.message || e);
  allowedTags = [];
}
const allowedTagsSet = new Set(allowedTags.map(t => String(t)));

// ====== Tag link builder (choose /all or /nutritional-supplements) ======
const TAG_BASE_COLLECTION = process.env.TAG_BASE_COLLECTION || 'all';
// If you prefer supplements-only, set TAG_BASE_COLLECTION="nutritional-supplements" in Render env.
const TAG_BASE_URL = `https://shop.healthandlight.com/collections/${TAG_BASE_COLLECTION}?filter.p.tag=`;
const makeTagLink = (t) => TAG_BASE_URL + encodeURIComponent(t);

// ====== Helpers for tag extraction from the model reply ======
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Flexible extractor for official tags inside free text
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

// ====== Deny noisy footer tags & add related tags ======
const TAG_DENYLIST = new Set([
  'Services','Supplements','Gifts','Gift Cards','Gifts For Her','Gifts for Her',
  'Clothing','T-shirts','Unisex','Jewelry','Home Decor','Wall Tapestries',
  'Notebooks/Journals','Recorded Meditations','Personal Care'
]);

// Curated related-tags map (only used if they exist in allowedTags)
const RELATED_TAGS = {
  'Anxiety': ['Stress','Sleep','Mood','Magnesium','Brain','Adapt & Thrive'],
  'Sleep': ['Anxiety','Stress','Magnesium','Mood'],
  'Stress': ['Anxiety','Sleep','Adapt & Thrive','Magnesium','Mood'],
  'Digestion': ['Gut Health','Probiotics','Enzymes','Leaky Gut'],
  'Brain': ['Memory & Focus','Mood','Omega-3s'],
  'Immune Support': ['Antioxidants'],
  'Detox': ['Heavy Metal Detox','Liver','Kidneys']
};

function expandRelatedTags(tags, limit = 6) {
  const out = [];
  for (const t of tags) {
    const rel = RELATED_TAGS[t] || [];
    for (const r of rel) {
      if (allowedTagsSet.has(r) && !TAG_DENYLIST.has(r)) out.push(r);
    }
  }
  return [...new Set(out)].slice(0, limit);
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

// ====== System prompt ======
function buildSystemPrompt() {
  return `
You are a warm, empathetic and professional AI wellness advisor for Health & Light Institute.

CORE RULES
- NEVER invent service or product names.
- Prefer what actually exists at https://shop.healthandlight.com.
- When talking about Services or Supplements, do not list category names inline.
- Instead, provide one concise sentence + a SINGLE filtered link:
  • Services: https://shop.healthandlight.com/collections/services?filter.p.tag=<TAG>
  • Supplements: https://shop.healthandlight.com/collections/nutritional-supplements?filter.p.tag=<TAG>
  Replace <TAG> with the user's topic (e.g., Anxiety, Sleep, Digestion). If no suitable tag exists, say so and offer the nearest related tag that DOES exist.

FOLLOW-UPS
- For follow-up questions in the same chat, do not repeat empathy you already expressed unless the user introduces a new concern (e.g., adds "sleep issues" after "anxiety").

STYLE / FORMAT
- Use clear headings and bullets. Exactly these sections, if relevant:
  **Services** – one sentence + the single filtered Services link.
  **Nutritional Supplements** – one sentence + the single filtered Supplements link.
  **Lifestyle & Dietary Suggestions** – grounded dietary and holistic lifestyle suggestions.

SAFETY / ACCURACY
- If there is no direct offering, say so plainly and suggest the nearest internal category link (filtered by tag).
- Include links only to our domain. No external claims or affiliate suggestions unless the user explicitly asks.
`.trim();
}

// ====== Root endpoint ======
app.get('/', (_req, res) => {
  res.send(
    `🚀 Chatbot backend is live.<br>` +
      `🤖 Model: <strong>${selectedModel}</strong><br>` +
      `🏷️ Tags loaded: <strong>${allowedTags.length}</strong> (base: /collections/${TAG_BASE_COLLECTION})`
  );
});

// Optional: quick tag debug
app.get('/debug/tags', (_req, res) => {
  res.json({ count: allowedTags.length, sample: allowedTags.slice(0, 12) });
});

// ====== Chat endpoint ======
app.post('/chat', async (req, res) => {
  try {
    const inbound = Array.isArray(req.body?.messages) ? req.body.messages : [];

    // Gather user-only text to infer primary tags from the conversation
    const userText = inbound.filter(m => m.role === 'user').map(m => m.content).join('\n\n');
    const primaryTags = extractTagsFrom(userText).slice(0, 4); // up to 4 main intents

    // Ensure system prompt is first and strip any other system prompts
    const fullMessages = [
      { role: 'system', content: buildSystemPrompt() },
      ...inbound.filter(m => m.role !== 'system')
    ];

    const chatCompletion = await openai.chat.completions.create({
      model: selectedModel,
      temperature: 0.5,
      messages: fullMessages,
    });

    let reply = chatCompletion.choices?.[0]?.message?.content || '';

    // ===== Footer: "Shop by category" (primary + related; no noisy tags) =====
    let footerTags = [...primaryTags];
    footerTags.push(...expandRelatedTags(primaryTags, 6));

    // Fallback if nothing detected from user messages: scan the reply text
    if (!footerTags.length) footerTags = extractTagsFrom(reply);

    // Clean + limit
    footerTags = [...new Set(footerTags)]
      .filter(t => !TAG_DENYLIST.has(t))
      .slice(0, 8);

    if (footerTags.length) {
      const links = footerTags.map(t => `- [${t}](${makeTagLink(t)})`).join('\n');
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
