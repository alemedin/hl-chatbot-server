// index.js
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai');

const app = express();
const port = process.env.PORT || 10000;

app.use(cors());
app.use(bodyParser.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---- Load known Shopify tags (export to tags_unique.json) ----
let TAGS = [];
try {
  const tagsPath = path.join(__dirname, 'tags_unique.json');
  TAGS = JSON.parse(fs.readFileSync(tagsPath, 'utf8'));
  console.log(`✅ Loaded ${TAGS.length} tags from tags_unique.json`);
} catch (e) {
  console.warn('⚠️ Could not load tags_unique.json. Tag linking will be disabled until you add it.');
  TAGS = [];
}
const TAG_SET = new Set(TAGS);

// ---- Helpers: choose base path, encode, and linkify ----
const serviceHint = /(watsu|waterdance|massage|session|consult|therapy|therap(y|ist)|class|workshop|reiki|bodywork|acupuncture|healing|treatment|facial|reflexology)/i;

function basePathForTag(tag) {
  if (serviceHint.test(tag)) return '/collections/services';
  // Default to supplements; adjust to /collections/all if you prefer
  return '/collections/nutritional-supplements';
}

// Shopify likes spaces as +. encodeURIComponent gives %20, so swap those.
function encodeShopifyTag(tag) {
  return encodeURIComponent(tag).replace(/%20/g, '+');
}

function tagUrl(tag, preferred = 'auto') {
  let base = '/collections/all';
  if (preferred === 'auto') base = basePathForTag(tag);
  else if (preferred === 'supp') base = '/collections/nutritional-supplements';
  else if (preferred === 'serv') base = '/collections/services';
  return `${base}?filter.p.tag=${encodeShopifyTag(tag)}`;
}

// Convert [tag:Exact Tag Name] → [Exact Tag Name](URL)
function injectTagLinks(text) {
  if (!text || TAGS.length === 0) return text;
  return text.replace(/\[tag:([^\]]+?)\]/g, (m, raw) => {
    const tag = raw.trim();
    if (!TAG_SET.has(tag)) return tag; // show plain text if unknown
    const url = tagUrl(tag, 'auto');
    return `[${tag}](${url})`;
  });
}

// ---- Pick best OpenAI model on startup (your original logic) ----
let selectedModel = 'gpt-4o'; // fallback
(async () => {
  try {
    const models = await openai.models.list();
    const sorted = models.data
      .filter(m => m.id.startsWith('gpt-') && (m.id.includes('turbo') || m.id.includes('gpt-4o')))
      .sort((a, b) => {
        const v = id => (id.includes('gpt-4o') ? 100 : (id.match(/gpt-(\d+(\.\d+)?)/) ? parseFloat(id.match(/gpt-(\d+(\.\d+)?)/)[1]) : 0));
        return v(b.id) - v(a.id);
      });
    if (sorted.length) {
      selectedModel = sorted[0].id;
      console.log(`✅ Auto-selected model: ${selectedModel}`);
    } else {
      console.warn('⚠️ No eligible GPT models found, using gpt-4o fallback.');
    }
  } catch (err) {
    console.error('❌ Failed to fetch models:', err.message || err);
  }
})();

// ---- Root ----
app.get('/', (req, res) => {
  res.send(`🚀 Chatbot backend is live.<br>🤖 Model: <strong>${selectedModel}</strong><br>🏷️ Tags loaded: <strong>${TAGS.length}</strong>`);
});

// ---- Chat ----
app.post('/chat', async (req, res) => {
  try {
    const { messages } = req.body;

    // System prompt – ask model to emit tag tokens we can convert
    const SYSTEM_PROMPT = {
      role: 'system',
      content: `
You are a warm, professional AI wellness advisor for Health & Light Institute.
Give accurate, concise guidance grounded ONLY in offerings at:
- https://shop.healthandlight.com/collections/services
- https://shop.healthandlight.com/collections/nutritional-supplements

Rules:
- Do NOT invent products/services. If none apply, say so and suggest general wellness only afterward.
- Include direct links to items or to TAG FILTER links via special tokens (below).
- Avoid repeating empathy lines in follow-ups; move to next helpful steps.

TAG LINKING (important):
- When recommending a **category**, output one line "Tag links:" followed by one or more tokens like:
  [tag:Probiotics] [tag:Magnesium] [tag:Watsu]
- Use ONLY tags from this exact list (case-sensitive). If a needed tag isn't here, skip it:
${TAGS.length ? TAGS.map(t => `- ${t}`).join('\n') : '- (No tags loaded on server)'}

FORMAT:
- Use **Headings**, bullet points, and short paragraphs.
- Put "Tag links:" as the last block when you use tags.
`
    };

    // Ensure system prompt is always first
    const fullMessages = [SYSTEM_PROMPT, ...messages.filter(m => m.role !== 'system')];

    const chat = await openai.chat.completions.create({
      model: selectedModel,
      messages: fullMessages,
      temperature: 0.3, // keep it factual and reduce hallucinations
    });

    let reply = chat.choices[0].message.content || 'Sorry, something went wrong.';
    reply = injectTagLinks(reply);
    res.json({ reply });
  } catch (error) {
    console.error('❌ Chat error:', error.message || error);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.listen(port, () => {
  console.log(`✅ Server listening on port ${port}`);
});
