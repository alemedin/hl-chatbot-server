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
  allowedTags = require('./tags_unique.json'); // JSON array of strings
  if (!Array.isArray(allowedTags)) allowedTags = [];
} catch (e) {
  console.warn('⚠️ Could not load tags_unique.json. Tag links will be disabled.', e?.message || e);
  allowedTags = [];
}
const allowedTagsSet      = new Set(allowedTags);
const allowedTagsLowerMap = new Map(allowedTags.map(t => [t.toLowerCase(), t]));

// ====== Tag link builders ======
const makeServicesLink = (t) =>
  `https://shop.healthandlight.com/collections/services?filter.p.tag=${encodeURIComponent(t)}`;
const makeSuppsLink = (t) =>
  `https://shop.healthandlight.com/collections/nutritional-supplements?filter.p.tag=${encodeURIComponent(t)}`;

// ====== Helpers ======
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function normalizeTag(nameRaw) {
  if (!nameRaw) return null;
  const candidate = decodeURIComponent(String(nameRaw)).trim().toLowerCase();
  return allowedTagsLowerMap.get(candidate) || null;
}

function extractTagsFrom(text) {
  if (!text || !allowedTags.length) return [];
  const hits = new Set();
  for (const raw of allowedTags) {
    let pat = escapeRegex(raw);
    pat = pat.replace(/\\&/g, '(?:&|and)');
    pat = pat.replace(/\\-/g, '[- ]?');
    const re = new RegExp(`(?:^|[^\\w])${pat}(?=[^\\w]|$)`, 'i');
    if (re.test(text)) hits.add(raw);
  }
  return [...hits];
}

const TAG_DENYLIST = new Set([
  'Services','Supplements','Gifts','Gift Cards','Gifts For Her','Gifts for Her',
  'Clothing','T-shirts','Unisex','Jewelry','Home Decor','Wall Tapestries',
  'Notebooks/Journals','Recorded Meditations','Personal Care'
]);

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

// Sanitize any raw links the model may emit and convert placeholders to real links
function sanitizeAndLinkify(reply) {
  if (!reply) return reply;

  // 1) Convert placeholders: [SERVICES_TAG: Anxiety] / [SUPPLEMENTS_TAG: Sleep]
  reply = reply.replace(/$begin:math:display$(SERVICES_TAG|SUPPLEMENTS_TAG):\\s*([^$end:math:display$]+?)\]/gi, (_, type, tagName) => {
    const tag = normalizeTag(tagName);
    if (!tag) return ''; // drop invalid tag
    const label = type.toUpperCase() === 'SERVICES_TAG'
      ? `${tag} Services`
      : `${tag} Nutritional Supplements`;
    const url = type.toUpperCase() === 'SERVICES_TAG'
      ? makeServicesLink(tag)
      : makeSuppsLink(tag);
    return `[${label}](${url})`;
  });

  // 2) If model still wrote raw Shopify links, validate their tags; drop/repair if needed
  reply = reply.replace(
    /$begin:math:display$([^$end:math:display$]+)\]$begin:math:text$(https:\\/\\/shop\\.healthandlight\\.com\\/collections\\/(services|nutritional-supplements)\\?filter\\.p\\.tag=([^)\\s]+))$end:math:text$/gi,
    (m, text, _url, coll, tagRaw) => {
      const tag = normalizeTag(tagRaw);
      if (!tag) return text; // keep text, remove bad link
      const url = coll.toLowerCase() === 'services' ? makeServicesLink(tag) : makeSuppsLink(tag);
      return `[${text}](${url})`;
    }
  );

  return reply;
}

// ====== Dynamic model selection ======
let selectedModel = 'gpt-4o';
(async () => {
  try {
    const models = await openai.models.list();
    const sorted = models.data
      .filter((m) => m.id.startsWith('gpt-') && (m.id.includes('turbo') || m.id.includes('gpt-4o')))
      .sort((a, b) => {
        const v = (id) => {
          if (id.includes('gpt-4o')) return 100;
          const m = id.match(/gpt-(\d+(\.\d+)?)/);
          return m ? parseFloat(m[1]) : 0;
        };
        return v(b.id) - v(a.id);
      });
    if (sorted.length) selectedModel = sorted[0].id;
    console.log(`✅ Auto-selected model: ${selectedModel}`);
  } catch (err) {
    console.error('❌ Failed to fetch models:', err?.message || err);
  }
})();

// ====== System prompt with placeholders ======
function buildSystemPrompt() {
  return `
You are a warm, empathetic and professional AI wellness advisor for Health & Light Institute.

CORE RULES
- NEVER invent service or product names.
- Prefer what actually exists at https://shop.healthandlight.com.
- Do NOT write raw Shopify links yourself.
- When you want to point to a category, output ONE placeholder instead:
  • Services placeholder: [SERVICES_TAG: <TAG>]
  • Supplements placeholder: [SUPPLEMENTS_TAG: <TAG>]
  The backend will convert placeholders to links only if <TAG> is a real store tag.

FOLLOW-UPS
- If you already expressed empathy once in the session, do not repeat it unless the user introduces a new concern (e.g., adds "sleep issues" after "anxiety").

STYLE / FORMAT
Use these sections where relevant:
**Services:** – one sentence + ONE placeholder ([SERVICES_TAG: Anxiety] for example).
**Nutritional Supplements:** – one sentence + ONE placeholder ([SUPPLEMENTS_TAG: Anxiety]).
**Lifestyle & Dietary Recommendations:** – concise, grounded tips (dietary guidance included).

ACCURACY
- If there is no direct offering for the user’s request, say so plainly and recommend the nearest relevant internal tag via a placeholder.
- Never include external links or affiliate suggestions unless explicitly asked.
`.trim();
}

// ====== Root endpoint ======
app.get('/', (_req, res) => {
  res.send(
    `🚀 Chatbot backend is live.<br>` +
    `🤖 Model: <strong>${selectedModel}</strong><br>` +
    `🏷️ Tags loaded: <strong>${allowedTags.length}</strong>`
  );
});

// ====== Chat endpoint ======
app.post('/chat', async (req, res) => {
  try {
    const inbound = Array.isArray(req.body?.messages) ? req.body.messages : [];

    // Infer primary tags from the user's messages (not the model's)
    const userText = inbound.filter(m => m.role === 'user').map(m => m.content).join('\n\n');
    const primaryTags = extractTagsFrom(userText).slice(0, 4);

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
    reply = sanitizeAndLinkify(reply);

    // Footer: primary + related (validated) without noisy tags
    let footerTags = [...primaryTags, ...expandRelatedTags(primaryTags, 6)];
    if (!footerTags.length) footerTags = extractTagsFrom(reply);

    footerTags = [...new Set(footerTags)]
      .filter(t => !TAG_DENYLIST.has(t))
      .slice(0, 8);

    if (footerTags.length) {
      const links = footerTags
        .sort((a, b) => a.localeCompare(b))
        .map(t => `- [${t}](${makeSuppsLink(t)})`) // footer links to supplements collection by default
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
