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

// ====== Direct service links for specials (Watsu) ======
// You provided the Watsu URL; we use it by default.
// You can override with env LINK_WATSU if needed.
const WATSU_URL = process.env.LINK_WATSU
  || 'https://shop.healthandlight.com/products/aquatic-bodywork-watsu-waterdance';

// ====== Related tag graph (for footer suggestions) ======
const KEYWORD_TAG_GRAPH = {
  'Anxiety': ['Stress','Sleep','Mood','Magnesium','Brain','Adapt & Thrive'],
  'Sleep': ['Anxiety','Stress','Magnesium','Mood'],
  'Stress': ['Anxiety','Sleep','Adapt & Thrive','Magnesium','Mood'],
  'Digestion': ['Gut Health','Probiotics','Enzymes','Leaky Gut'],
  'Brain': ['Memory & Focus','Mood','Omega-3s'],
  'Immune Support': ['Antioxidants'],
  'Detox': ['Heavy Metal Detox','Liver','Kidneys']
};

// ====== Tag link builders ======
const makeServicesLink = (t) =>
  `https://shop.healthandlight.com/collections/services?filter.p.tag=${encodeURIComponent(t)}`;
const makeSuppsLink = (t) =>
  `https://shop.healthandlight.com/collections/nutritional-supplements?filter.p.tag=${encodeURIComponent(t)}`;
const makeAllLink = (t) =>
  `https://shop.healthandlight.com/collections/all?filter.p.tag=${encodeURIComponent(t)}`;

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
    // flexible matching: "&" ~ "and", "-" ~ optional space
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

function expandRelatedTags(tags, limit = 6) {
  const out = [];
  for (const t of tags) {
    const rel = KEYWORD_TAG_GRAPH[t] || [];
    for (const r of rel) {
      if (allowedTagsSet.has(r) && !TAG_DENYLIST.has(r)) out.push(r);
    }
  }
  return [...new Set(out)].slice(0, limit);
}

// Convert placeholders to Shopify links, and repair any raw links if present
function sanitizeAndLinkify(reply) {
  if (!reply) return reply;

  // 1) Convert placeholders like: [SERVICES_TAG: Anxiety] / [SUPPLEMENTS_TAG: Sleep]
  reply = reply.replace(/\[(SERVICES_TAG|SUPPLEMENTS_TAG):\s*([^\]]+)\]/gi, (_m, type, tagName) => {
    const tag = normalizeTag(tagName);
    if (!tag) return ''; // drop invalid tag
    const url = type.toUpperCase() === 'SERVICES_TAG' ? makeServicesLink(tag) : makeSuppsLink(tag);
    const label = type.toUpperCase() === 'SERVICES_TAG' ? `${tag} Services` : `${tag} Nutritional Supplements`;
    return `[${label}](${url})`;
  });

  // 2) If the model wrote a raw Shopify collection link, validate the tag
  reply = reply.replace(
    /(https:\/\/shop\.healthandlight\.com\/collections\/(services|nutritional-supplements)\?filter\.p\.tag=)([^\s)\]]+)/gi,
    (_m, base, coll, tagRaw) => {
      const tag = normalizeTag(tagRaw);
      if (!tag) return base + encodeURIComponent(''); // neuter bad tag
      return coll.toLowerCase() === 'services' ? makeServicesLink(tag) : makeSuppsLink(tag);
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

// ====== System prompt with placeholders + Watsu exception ======
function buildSystemPrompt() {
  return `
You are a warm, empathetic and professional AI wellness advisor for Health & Light Institute.

CORE RULES
- NEVER invent service or product names.
- Prefer what actually exists at https://shop.healthandlight.com.
- Do NOT write raw Shopify links yourself (except the single Watsu link below).
- When you want to point to a category, output ONE placeholder instead:
  • Services placeholder: [SERVICES_TAG: <TAG>]
  • Supplements placeholder: [SUPPLEMENTS_TAG: <TAG>]
  The backend will convert placeholders to links only if <TAG> is a real store tag.

FOLLOW-UPS
- If you already expressed empathy once in the session, do not repeat it unless the user introduces a new concern (e.g., adds "sleep issues" after "anxiety").

SPECIAL CASES
- If the user asks about “Watsu”, “aquatic bodywork”, “water shiatsu”, or “waterdance”: treat it as AVAILABLE and include this direct link: https://shop.healthandlight.com/products/aquatic-bodywork-watsu-waterdance
  You may ALSO include a broader category via a placeholder like [SERVICES_TAG: Bodywork] if appropriate.

STYLE / FORMAT
Use these sections where relevant:
**Services:** – one sentence + ONE placeholder (e.g., [SERVICES_TAG: Anxiety]).
**Nutritional Supplements:** – one sentence + ONE placeholder (e.g., [SUPPLEMENTS_TAG: Anxiety]).
**Lifestyle & Dietary Recommendations:** – concise, grounded holistic health & wellness tips (include dietary guidance).

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

    // Never imply Watsu is unavailable; if Watsu is in scope, ensure link appears
    const mentionsWatsu = /watsu|aquatic bodywork|water\s*shiatsu|waterdance/i.test(userText + '\n' + reply);
    if (mentionsWatsu) {
      // remove any "we don't offer watsu" phrasing if produced
      reply = reply.replace(/(?:we|i)\s+do(?:\s*not|n't)?\s+offer\s+watsu[^.?!]*[.?!]?/gi, '');
      if (!/\bhttps?:\/\/\S+aquatic-bodywork-watsu-waterdance/i.test(reply)) {
        reply += `\n\n**Featured Service:**\n- [Watsu (Aquatic Bodywork)](${WATSU_URL})`;
      }
    }

    // Convert placeholders and repair raw links
    reply = sanitizeAndLinkify(reply);

    // Footer: primary + related (validated) without noisy tags
    let footerTags = [...primaryTags, ...expandRelatedTags(primaryTags, 6)];
    if (!footerTags.length) footerTags = extractTagsFrom(reply);

    footerTags = [...new Set(footerTags)]
      .filter(t => allowedTagsSet.has(t) && !TAG_DENYLIST.has(t))
      .slice(0, 8);

    if (footerTags.length) {
      const links = footerTags
        .sort((a, b) => a.localeCompare(b))
        .map(t => `- [${t}](${makeAllLink(t)})`) // footer links to all collections by default
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
