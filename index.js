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

// ====== Load allowed store tags (JSON array of strings) ======
let allowedTags = [];
try {
  allowedTags = require('./tags_unique.json');
  if (!Array.isArray(allowedTags)) allowedTags = [];
} catch (e) {
  console.warn('⚠️ Could not load tags_unique.json. Tag links will be disabled.', e?.message || e);
  allowedTags = [];
}
const allowedTagsSet      = new Set(allowedTags);
const allowedTagsLowerMap = new Map(allowedTags.map(t => [t.toLowerCase(), t]));

// ====== Canonical tag aliases (synonyms → your real tag names) ======
const TAG_ALIASES = new Map([
  // Cancer family: always map to your canonical tag
  ['cancer', 'Cancer Support'],
  ['breast cancer', 'Cancer Support'],
  ['oncology', 'Cancer Support'],
  ['chemotherapy', 'Cancer Support'],
  ['radiation', 'Cancer Support'],
]);

// ====== Service-only blocklist (tags you don’t use for Services) ======
// Use ONLY canonical tags here (after normalization, see normalizeTag).
const SERVICE_TAG_BLOCKLIST = new Set([
  'Cancer Support'
]);

// Choose which tag to pivot to when a services tag is blocked (e.g., Cancer Support)
function serviceFallbackFor(_tag) {
  const prefs = ['Stress', 'Sleep', 'Anxiety', 'Bodywork', 'Adapt & Thrive'];
  for (const p of prefs) {
    if (allowedTagsSet.has(p)) return p;
  }
  return null;
}

// ====== Direct service links for specials (Watsu) ======
const WATSU_URL =
  process.env.LINK_WATSU ||
  'https://shop.healthandlight.com/products/aquatic-bodywork-watsu-waterdance';

// ====== Related tag graph (for footer suggestions) ======
const KEYWORD_TAG_GRAPH = {
  'Anxiety': ['Stress','Sleep','Mood','Magnesium','Brain','Adapt & Thrive'],
  'Sleep': ['Anxiety','Stress','Magnesium','Mood'],
  'Stress': ['Anxiety','Sleep','Adapt & Thrive','Magnesium','Mood'],
  'Digestion': ['Gut Health','Probiotics','Enzymes','Leaky Gut'],
  'Brain': ['Memory & Focus','Mood','Omega-3s'],
  'Immune Support': ['Antioxidants'],
  'Detox': ['Heavy Metal Detox','Liver','Kidneys'],
  // NEW: when user says “cancer”, surface supportive categories
  'Cancer Support': ['Immune Support','Antioxidants','Stress','Sleep','Detox','Liver']
};

// ====== Link builders ======
const makeServicesLink = (t) =>
  `https://shop.healthandlight.com/collections/services?filter.p.tag=${encodeURIComponent(t)}`;
const makeSuppsLink = (t) =>
  `https://shop.healthandlight.com/collections/nutritional-supplements?filter.p.tag=${encodeURIComponent(t)}`;
const makeAllLink = (t) =>
  `https://shop.healthandlight.com/collections/all?filter.p.tag=${encodeURIComponent(t)}`;

// Blog tag links need a slug: lowercased, spaces->hyphens, "&"->"and", strip non-alphanum
function slugifyTagForBlog(tag) {
  return String(tag)
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}
const makeArticlesLink = (t) =>
  `https://shop.healthandlight.com/blogs/news/tagged/${slugifyTagForBlog(t)}`;

// ====== Helpers ======
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Normalize any incoming tag-like text to one of your allowed tags.
// 1) exact match, 2) alias map, 3) special contains("cancer") → Cancer Support
function normalizeTag(nameRaw) {
  if (!nameRaw) return null;
  const candidate = decodeURIComponent(String(nameRaw)).trim().toLowerCase();

  // exact allowed tag
  const exact = allowedTagsLowerMap.get(candidate);
  if (exact) return exact;

  // alias map
  const alias = TAG_ALIASES.get(candidate) ||
                (candidate.includes('cancer') ? 'Cancer Support' : null);

  if (alias && allowedTagsSet.has(alias)) return alias;
  return null;
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

const TAG_DENYLIST_FOOTER = new Set([
  'Services','Supplements','Gifts','Gift Cards','Gifts For Her','Gifts for Her',
  'Clothing','T-shirts','Unisex','Jewelry','Home Decor','Wall Tapestries',
  'Notebooks/Journals','Recorded Meditations','Personal Care'
]);

function expandRelatedTags(tags, limit = 6) {
  const out = [];
  for (const t of tags) {
    const rel = KEYWORD_TAG_GRAPH[t] || [];
    for (const r of rel) {
      if (allowedTagsSet.has(r) && !TAG_DENYLIST_FOOTER.has(r)) out.push(r);
    }
  }
  return [...new Set(out)].slice(0, limit);
}

// ====== Current-turn synonym → tag mapping (use canonical names) ======
const KEYWORD_TO_TAG = [
  { re: /\b(insomnia|trouble sleeping|sleep (issues|problems)|can'?t sleep|sleeping)\b/i, tag: 'Sleep' },
  { re: /\b(anxiety|anxious|panic( attack)?s?)\b/i, tag: 'Anxiety' },
  { re: /\b(stress|stressed|overwhelm(ed)?)\b/i, tag: 'Stress' },
  { re: /\b(brain fog|focus|concentration|memory)\b/i, tag: 'Brain' },
  { re: /\b(mood|low mood|irritable|irritability)\b/i, tag: 'Mood' },
  // cancer-family → map straight to your canonical tag
  { re: /\b(breast\s*cancer|cancer|oncolog(y|ist)|chemotherapy|radiation)\b/i, tag: 'Cancer Support' }
];

function inferTagFromFreeText(txt) {
  if (!txt) return null;
  for (const { re, tag } of KEYWORD_TO_TAG) {
    if (re.test(txt)) return tag;
  }
  return null;
}

function isCancerIntent(txt) {
  return /\b(breast\s*cancer|cancer|oncolog(y|ist)|chemotherapy|radiation)\b/i.test(txt || '');
}

/** Convert placeholders to links with per-collection rules (services blocklist respected). */
function convertPlaceholders(reply, preferredTag) {
  if (!reply) return reply;

  return reply.replace(/\[(SERVICES_TAG|SUPPLEMENTS_TAG|ARTICLES_TAG):\s*([^\]]+)\]/gi, (_m, type, tagName) => {
    let tag = normalizeTag(tagName) || normalizeTag(preferredTag);
    if (!tag) return ''; // drop invalid

    if (type.toUpperCase() === 'SERVICES_TAG') {
      if (SERVICE_TAG_BLOCKLIST.has(tag)) {
        const fb = serviceFallbackFor(tag);
        tag = fb || null;
      }
      if (!tag) return ''; // still invalid for services — drop
      return `[${tag} Services](${makeServicesLink(tag)})`;
    }

    if (type.toUpperCase() === 'SUPPLEMENTS_TAG') {
      return `[${tag} Nutritional Supplements](${makeSuppsLink(tag)})`;
    }

    // ARTICLES_TAG
    return `[${tag} Articles](${makeArticlesLink(tag)})`;
  });
}

/** Repair/validate raw links the model may emit; enforce services blocklist. */
function sanitizeLinks(reply, preferredTag) {
  if (!reply) return reply;

  // collections links (services / supplements / all)
  reply = reply.replace(
    /(https:\/\/shop\.healthandlight\.com\/collections\/)(services|nutritional-supplements|all)(\?filter\.p\.tag=)([^\s)\]]+)/gi,
    (_m, base, coll, qs, raw) => {
      let tag = normalizeTag(raw) || normalizeTag(preferredTag);
      if (!tag) return base + coll; // neuter

      if (coll.toLowerCase() === 'services' && SERVICE_TAG_BLOCKLIST.has(tag)) {
        const fb = serviceFallbackFor(tag);
        tag = fb || null;
      }
      if (!tag) return base + coll;

      if (coll.toLowerCase() === 'services') return makeServicesLink(tag);
      if (coll.toLowerCase() === 'nutritional-supplements') return makeSuppsLink(tag);
      return makeAllLink(tag);
    }
  );

  // blog article links
  reply = reply.replace(
    /(https:\/\/shop\.healthandlight\.com\/blogs\/news\/tagged\/)([^\s)\]]]+)/gi,
    (_m, base, slug) => {
      // try to map slug back to a tag
      const guess = slug.replace(/-/g, ' ').replace(/and/g, '&');
      let tag = normalizeTag(guess) || normalizeTag(slug) || normalizeTag(preferredTag);
      if (!tag) return base + 'wellness';
      return base + slugifyTagForBlog(tag);
    }
  );

  return reply;
}

/** Ensure that Services / Supplements / Articles sections each have exactly one correct link. */
function ensureSectionsHaveOneLink(reply, preferredTag) {
  if (!reply) return reply;
  let tag = normalizeTag(preferredTag);

  // SERVICES section — enforce fallback if needed
  let serviceTag = tag;
  if (!serviceTag || SERVICE_TAG_BLOCKLIST.has(serviceTag)) {
    serviceTag = serviceFallbackFor(serviceTag || ''); // may become null
  }

  // If there is a Services section, ensure one valid link
  if (/(^|\n)\s*(\*\*)?\s*Services\s*\2?\s*:?/i.test(reply)) {
    const link = serviceTag ? `- [${serviceTag} Services](${makeServicesLink(serviceTag)})` : '';
    // remove any existing services collection links, then add our single one (if available)
    reply = reply
      .replace(/\n- \[[^\]]+\]\(https:\/\/shop\.healthandlight\.com\/collections\/services\?[^\)]+\)/gi, '')
      .replace(/(^|\n)(\*\*)?\s*Services\s*\2?\s*:?[^\n]*\n?/i, (m) => m + (link ? `\n${link}\n` : '\n'));
  }

  // SUPPLEMENTS section — use preferred tag if present
  if (/(^|\n)\s*(\*\*)?\s*Nutritional\s+Supplements\s*\2?\s*:?/i.test(reply)) {
    const suppTag = tag;
    const link = suppTag ? `- [${suppTag} Nutritional Supplements](${makeSuppsLink(suppTag)})` : '';
    reply = reply
      .replace(/\n- \[[^\]]+\]\(https:\/\/shop\.healthandlight\.com\/collections\/nutritional-supplements\?[^\)]+\)/gi, '')
      .replace(/(^|\n)(\*\*)?\s*Nutritional\s+Supplements\s*\2?\s*:?[^\n]*\n?/i, (m) => m + (link ? `\n${link}\n` : '\n'));
  }

  // ARTICLES section — use preferred tag if present
  if (/(^|\n)\s*(\*\*)?\s*Articles\s*\2?\s*:?/i.test(reply)) {
    const articleTag = tag;
    const link = articleTag ? `- [${articleTag} Articles](${makeArticlesLink(articleTag)})` : '';
    reply = reply
      .replace(/\n- \[[^\]]+\]\(https:\/\/shop\.healthandlight\.com\/blogs\/news\/tagged\/[^\)]+\)/gi, '')
      .replace(/(^|\n)(\*\*)?\s*Articles\s*\2?\s*:?[^\n]*\n?/i, (m) => m + (link ? `\n${link}\n` : '\n'));
  }

  return reply;
}

// ====== Dynamic model selection ======
let selectedModel = 'gpt-4o';
(async () => {
  try {
    const models = await openai.models.list();
    const sorted = models.data
      .filter(m => m.id.startsWith('gpt-') && (m.id.includes('turbo') || m.id.includes('gpt-4o')))
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
  • Articles placeholder: [ARTICLES_TAG: <TAG>]
  The backend will convert placeholders to links only if <TAG> is a real store tag.

LINK DISCIPLINE (IMPORTANT)
- For each section (**Services**, **Nutritional Supplements**, **Articles**) include **exactly one** link for that section.
- Do not repeat the same link as a separate bullet or standalone line in the same section.
- Keep links under their section only; avoid echoing the same link again.

FOLLOW-UPS
- If you already expressed empathy once in the session, do not repeat it unless the user introduces a new concern (e.g., adds "sleep issues" after "anxiety").

SPECIAL CASES
- If the user asks about “Watsu”, “aquatic bodywork”, “water shiatsu”, or “waterdance”: treat it as AVAILABLE and include this direct link: https://shop.healthandlight.com/products/aquatic-bodywork-watsu-waterdance
  You may ALSO include a broader category via a placeholder like [SERVICES_TAG: Bodywork] if appropriate.

STYLE / FORMAT
Use these sections where relevant:
**Services:** – one sentence + ONE placeholder (e.g., [SERVICES_TAG: Anxiety]).
**Nutritional Supplements:** – one sentence + ONE placeholder (e.g., [SUPPLEMENTS_TAG: Anxiety]).
**Articles:** – one sentence + ONE blog link placeholder (e.g., [ARTICLES_TAG: Anxiety]).
**Lifestyle & Dietary Recommendations:** – concise, grounded holistic tips (include dietary guidance).

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

    // Latest user message (for this turn’s intent)
    const lastUserMsg = [...inbound].reverse().find(m => m.role === 'user')?.content || '';
    const cancerIntent = isCancerIntent(lastUserMsg); // (kept if you want to branch later)

    // Preferred tag for THIS turn (what user just asked about)
    let preferredTag =
      extractTagsFrom(lastUserMsg)[0] ||
      inferTagFromFreeText(lastUserMsg);

    // Build full messages (force the model to use placeholders)
    const fullMessages = [
      { role: 'system', content: buildSystemPrompt() },
      preferredTag
        ? { role: 'system', content: `For THIS reply, if you include **Services**, **Nutritional Supplements**, or **Articles**, use the placeholder tag: ${preferredTag}.` }
        : null,
      ...inbound.filter(m => m.role !== 'system')
    ].filter(Boolean);

    const chatCompletion = await openai.chat.completions.create({
      model: selectedModel,
      temperature: 0.5,
      messages: fullMessages,
    });

    let reply = chatCompletion.choices?.[0]?.message?.content || '';

    // Never imply Watsu is unavailable; if Watsu is in scope, ensure link appears
    const mentionsWatsu = /watsu|aquatic bodywork|water\s*shiatsu|waterdance/i.test(lastUserMsg + '\n' + reply);
    if (mentionsWatsu) {
      reply = reply.replace(/(?:we|i)\s+do(?:\s*not|n't)?\s+offer\s+watsu[^.?!]*[.?!]?/gi, '');
      if (!/\bhttps?:\/\/\S+aquatic-bodywork-watsu-waterdance/i.test(reply)) {
        reply += `\n\n**Featured Service:**\n- [Watsu (Aquatic Bodywork)](${WATSU_URL})`;
      }
    }

    // 1) Convert placeholders with per-collection rules (services blocklist respected)
    reply = convertPlaceholders(reply, preferredTag);

    // 2) Sanitize/repair any raw links the model might have produced
    reply = sanitizeLinks(reply, preferredTag);

    // 3) Ensure each section (if present) carries exactly one correct link
    reply = ensureSectionsHaveOneLink(reply, preferredTag);

    // Footer: suggest primary + related tags (ALL collection)
    const userTextAll = inbound.filter(m => m.role === 'user').map(m => m.content).join('\n\n');
    let footerTags = preferredTag
      ? [preferredTag, ...expandRelatedTags([preferredTag], 6)]
      : extractTagsFrom(userTextAll).slice(0, 4);

    if (!footerTags.length) footerTags = extractTagsFrom(reply);

    footerTags = [...new Set(footerTags)]
      .filter(t => allowedTagsSet.has(t) && !TAG_DENYLIST_FOOTER.has(t))
      .slice(0, 8);

    if (footerTags.length) {
      const links = footerTags
        .sort((a, b) => a.localeCompare(b))
        .map(t => `- [${t}](${makeAllLink(t)})`)
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
