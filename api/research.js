/* NOETIS discovery engine
   ------------------------------------------------------------------
   A Vercel serverless function. The browser cannot crawl another site (the browser blocks it) and
   cannot hold an API key, so the crawl and the research happen here.

   POST /api/research  { brand: { id, name, website, category, geography } }
     → a stream of newline-delimited JSON events, exactly what the app's RemoteEngine reads:
       { stage, kind: "ok" | "warn" | "skip", msg, write?: { table, row } }
     Every row it writes arrives in the app as a candidate. Nothing it finds is treated as
     confirmed until a person confirms it on the review screen.

   GET /api/research
     → { engine: "noetis-research", ready, reason } so the app can tell whether it is configured
       without guessing.

   Model routing: the cheapest model that can do each job.
     pass 1  extraction    Haiku reads the raw pages and pulls out what the brand says, verbatim.
                           This is the token-heavy step (tens of thousands of characters of page
                           text) and it is literal work, so it goes to the cheapest model.
     pass 2  analysis      Sonnet takes pass 1's compact result — not the raw pages — and does the
                           reasoning: category research with web search, competitors, signals,
                           positioning. A fraction of the input tokens of pass 1.
     Opus is never called. Set RESEARCH_MODEL_ANALYSE if a particular brand genuinely needs it.
   Two calls cost less here than one, because the expensive pass never sees the raw page text.
   On a re-run the app sends what is already on file and the engine is told not to return it again.

   Environment:
     ANTHROPIC_API_KEY        required
     RESEARCH_MODEL_EXTRACT   optional, the page-reading model. Default below.
     RESEARCH_MODEL_ANALYSE   optional, the reasoning model. Default below.
     RESEARCH_MODEL           optional, legacy: overrides both if set.
     RESEARCH_WEB_SEARCH      optional, "0" turns off external research and reads only the site
     RESEARCH_SEARCH_USES     optional, cap on web searches per run. Default 6.
     RESEARCH_MAX_PAGES       optional, how many of the brand's pages to read. Default 8.
     FIRECRAWL_API_KEY        optional. A plain fetch cannot read a page that builds itself in the
                              browser; with this set, such a page is retried through Firecrawl's
                              renderer instead of being written off as unreadable.

   What it will not do: invent a fact to fill a gap, state a market size or share, or return a
   source URL it did not actually retrieve. Empty is a valid answer and is filed as a gap.
*/

const MODELS = {
  extract: process.env.RESEARCH_MODEL || process.env.RESEARCH_MODEL_EXTRACT || "claude-haiku-5-5",
  analyse: process.env.RESEARCH_MODEL || process.env.RESEARCH_MODEL_ANALYSE || "claude-sonnet-5-5"
};
const SEARCH_USES = Math.max(0, Math.min(12, Number(process.env.RESEARCH_SEARCH_USES || 6)));
const WEB_SEARCH_TOOL = "web_search_20250305"; // change if Anthropic ships a newer server tool
const UA = "NoetisIntelligenceBot/1.0 (brand research; contact the site owner's analytics team)";
const MAX_PAGES = Math.max(1, Math.min(14, Number(process.env.RESEARCH_MAX_PAGES || 8)));
const PAGE_BYTES = 6_000_000, PAGE_CHARS = 9000, FETCH_MS = 15_000, SITEMAP_CAP = 400;

/* What a page looks like it is, judged from its real URL and link text. Nothing is assumed to
   exist: these only classify URLs the site actually publishes. */
const KINDS = [
  ["About", ["about", "story", "who-we-are", "our-story", "mission", "team", "founders"], 2],
  ["Products and services", ["product", "shop", "store", "range", "collection", "service", "catalog", "catalogue", "menu", "buy"], 3],
  ["Pricing", ["pricing", "price", "plans", "subscribe", "membership"], 1],
  ["FAQ", ["faq", "help", "support", "questions", "how-it-works"], 1],
  ["Contact", ["contact", "stockist", "store-locator", "find-us", "locations"], 1],
  ["Case study", ["case-stud", "customer-stor", "success-stor", "testimonial", "results"], 1],
  ["Blog or resources", ["blog", "journal", "resources", "guides", "learn", "news", "articles"], 1]
];
/* Never worth a crawl: private flows, machine files, and the endless tails of a site. */
const SKIP_RE = /(\/(login|signin|sign-in|register|signup|account|cart|checkout|basket|order|wishlist|search|wp-admin|wp-login|admin|privacy|terms|cookie|returns|shipping-policy|refund)(\/|$|\?))|(\.(xml|json|pdf|zip|jpe?g|png|gif|webp|svg|mp4|mp3|css|js|ico|woff2?)($|\?))|([?&](page|p|start|offset)=\d{2,})|(\/page\/\d+)|(\/(tag|tags|author)\/)/i;
const kindOf = url => { const p = (url.pathname + url.search).toLowerCase();
  for (const [name, keys] of KINDS) if (keys.some(k => p.includes(k))) return name;
  return "Other page"; };

/* The labels the app expects, per section. A label outside this list still files, but one of
   these lands in the right row of the brand canvas instead of under "also recorded". */
const STAGE = { SITE: 0, PRODUCTS: 1, BUSINESS: 2, AUDIENCE: 3, POSITIONING: 4, MARKET: 5, MARKETING: 6, SYNTHESIS: 7 };
const FIELDS = {
  dna: ["Purpose", "Mission", "Vision", "Brand promise", "Values", "Personality", "Tone of voice", "Messaging pillars", "Visual identity"],
  business: ["What the business is", "Business model", "Revenue model", "Problem it solves", "Business objectives", "Growth priority", "Business stage", "Distribution", "Channels in use", "Social presence"],
  positioning: ["Positioning statement", "Value proposition", "Differentiators", "Price position", "Perceived strengths", "Perceived weaknesses", "Messaging consistency", "Positioning gaps", "Repositioning to consider"],
  needs: ["Customer needs", "Motivations", "Pain points", "Purchase triggers", "Objections", "Buying behaviour"],
  category: ["Market overview", "Category developments", "Consumer behaviour shifts", "Industry trends", "Demand patterns", "Pricing movements", "Regulatory or technology change", "Geographic differences"],
  marketing: ["Website assessment", "Public social presence", "Visible marketing channels", "Content themes", "Public campaigns", "Distribution and acquisition signals", "Partnerships", "Marketing gaps"],
  objectives: ["Observed priority", "Inferred priority", "To validate with the founder"],
  assessment: ["Where the brand stands today", "Strongest visible advantages", "Potential challenges", "Where positioning could improve", "What deserves further investigation"]
};
/* Which stage each section's findings belong to, so progress reflects real work. */
const SECTION_STAGE = { business: STAGE.BUSINESS, dna: STAGE.POSITIONING, positioning: STAGE.POSITIONING, needs: STAGE.AUDIENCE, category: STAGE.MARKET, marketing: STAGE.MARKETING, objectives: STAGE.SYNTHESIS, assessment: STAGE.SYNTHESIS };

/* ---------- small helpers ---------- */
const clamp = (v, n) => String(v == null ? "" : v).slice(0, n).trim();
const ok = v => typeof v === "string" && v.trim().length > 0;
const isUrl = u => /^https?:\/\/[^\s"'<>]+$/i.test(String(u || ""));
const oneOf = (v, list, fallback) => list.includes(v) ? v : fallback;
const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ""));

function siteUrl(website) {
  const raw = String(website || "").trim();
  if (!raw) return null;
  try { return new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw); } catch { return null; }
};

/* accept: "html" for pages, "xml" for sitemaps. A big page is truncated, never refused: the
   first megabyte of a page carries everything we read from it. */
async function get(url, { timeout = FETCH_MS, accept = "html" } = {}) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), timeout);
  const okType = accept === "xml" ? /xml|text\/plain/i : /text\/html|text\/plain|application\/xhtml|xml/i;
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: "follow", headers: { "User-Agent": UA,
      Accept: accept === "xml" ? "application/xml,text/xml;q=0.9,*/*;q=0.5" : "text/html,application/xhtml+xml,text/plain;q=0.9" } });
    const type = res.headers.get("content-type") || "";
    if (!res.ok) return { ok: false, status: res.status, reason: `answered ${res.status}` };
    if (type && !okType.test(type)) return { ok: false, status: res.status, reason: `is ${type.split(";")[0] || "not a web page"}` };
    const buf = await res.arrayBuffer();
    const slice = buf.byteLength > PAGE_BYTES ? buf.slice(0, PAGE_BYTES) : buf;
    return { ok: true, status: res.status, url: res.url, truncated: buf.byteLength > PAGE_BYTES, html: new TextDecoder("utf-8").decode(slice) };
  } catch (e) {
    return { ok: false, reason: e.name === "AbortError" ? "timed out" : (e.message || "could not be reached") };
  } finally { clearTimeout(t); }
};

/* robots.txt, read for the * group only. A Disallow we match means we do not fetch the page. */
async function robots(origin) {
  const r = await get(origin + "/robots.txt", { timeout: 6000 });
  if (!r.ok) return { rules: [], sitemaps: [], fetched: false };
  const rules = [], sitemaps = []; let inStar = false;
  for (const raw of r.html.split("\n")) {
    const line = raw.split("#")[0].trim(); if (!line) continue;
    const [kRaw, ...rest] = line.split(":"); const k = kRaw.trim().toLowerCase(), v = rest.join(":").trim();
    if (k === "user-agent") inStar = v === "*";
    else if (k === "sitemap" && v && !sitemaps.includes(v)) sitemaps.push(v);
    else if (inStar && (k === "allow" || k === "disallow") && v) rules.push({ allow: k === "allow", path: v });
  }
  return { rules, sitemaps, fetched: true };
}

/* Read the sitemaps the site declares, then the usual location, following one level of index. */
async function sitemapUrls(base, declared) {
  const tried = new Set(), urls = [], notes = [];
  const read = async (u, depth) => {
    if (tried.has(u) || tried.size > 6 || urls.length > SITEMAP_CAP) return;
    tried.add(u);
    const r = await get(u, { timeout: 8000, accept: "xml" });
    if (!r.ok) { notes.push(`${u.split("/").pop()} ${r.reason}`); return; }
    const locs = [...r.html.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => m[1]);
    const isIndex = /<sitemapindex/i.test(r.html);
    if (isIndex && depth < 1) { for (const l of locs.slice(0, 5)) await read(l, depth + 1); return; }
    for (const l of locs) { if (urls.length > SITEMAP_CAP) break; urls.push(l); }
  };
  for (const u of declared) await read(u, 0);
  if (!urls.length) for (const u of [base.origin + "/sitemap.xml", base.origin + "/sitemap_index.xml", base.origin + "/sitemap-index.xml"]) await read(u, 0);
  return { urls, note: urls.length ? "" : notes.slice(0, 1).join("") };
}

/* A plain fetch cannot see a page that builds itself in the browser. When one comes back empty
   and a rendering crawler is configured, try that before calling the page unreadable. */
async function firecrawl(url) {
  const key = process.env.FIRECRAWL_API_KEY; if (!key) return null;
  try {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), 25_000);
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", { method: "POST", signal: ac.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true, timeout: 20_000 }) });
    clearTimeout(t);
    if (!res.ok) return { ok: false, reason: `the rendering crawler answered ${res.status}` };
    const j = await res.json();
    const md = j && j.data && j.data.markdown;
    if (!md) return { ok: false, reason: "the rendering crawler returned no content" };
    return { ok: true, url: (j.data.metadata && j.data.metadata.sourceURL) || url, text: String(md).slice(0, PAGE_CHARS),
      title: (j.data.metadata && (j.data.metadata.title || j.data.metadata.ogTitle)) || "", via: "rendered" };
  } catch (e) { return { ok: false, reason: e.name === "AbortError" ? "the rendering crawler timed out" : String(e.message || e) }; }
}

/* One page, by whatever means works: plain fetch first because it is free and fast. */
async function readPage(url) {
  const p = await get(url);
  if (p.ok) { const text = textOf(p.html); if (text.length >= 400) return { ok: true, url: p.url || url, text, title: titleOf(p.html), via: "fetched" };
    const fc = await firecrawl(url);
    if (fc && fc.ok) return fc;
    return { ok: true, url: p.url || url, text, title: titleOf(p.html), via: "fetched", thin: true }; }
  const fc = await firecrawl(url);
  if (fc && fc.ok) return fc;
  return { ok: false, reason: p.reason + (fc ? ` · ${fc.reason}` : ""), status: p.status };
}

const titleOf = html => {
  const t = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || "";
  return t.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
};;
const robotsAllows = (rules, path) => {
  let best = null;
  for (const r of rules) if (path.startsWith(r.path) && (!best || r.path.length > best.path.length)) best = r;
  return !best || best.allow;
};

function textOf(html) {
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ").replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ").replace(/<\/(p|div|li|h[1-6]|tr|section)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const txt = body.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .split("\n").map(l => l.replace(/[ \t ]+/g, " ").trim()).filter(Boolean).join("\n");
  return txt.slice(0, PAGE_CHARS);
};

/* Every internal link the page offers. Filtering and ranking happen on the real URLs. */
function links(html, baseUrl) {
  const out = [];
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#\s]+)["']/gi)) out.push(m[1]);
  return [...new Set(out)];
};

/* ---------- the two passes ---------- */
async function call(model, body, label) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, ...body })
  });
  if (!res.ok) { const t = await res.text(); const e = new Error(`${label} (${model}) answered ${res.status}: ${t.slice(0, 300)}`); e.status = res.status; throw e; }
  const data = await res.json();
  const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("").trim();
  const u = data.usage || {};
  return { text, usage: { in: u.input_tokens || 0, out: u.output_tokens || 0 } };
}
function asJson(text, label) {
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error(`${label} did not return JSON`);
  return JSON.parse(text.slice(a, b + 1));
}

/* Pass 1 — literal extraction. No reasoning asked for, so the cheapest model does it. */
function extractPrompt(brand, pages) {
  return `Read these pages from one company's website and pull out only what the company says about itself. Do not interpret, do not research, do not add anything that is not on the page.

COMPANY: ${brand.name} · ${brand.website}

${pages.map(p => `### ${p.name} — ${p.url}\n${p.text || "(nothing readable)"}`).join("\n\n")}

Return ONE JSON object, nothing else:
{
  "geography": "the country it operates in, only if a page says so",
  "markets": "other countries named on the pages, comma separated",
  "category": "how the company describes what it sells, in its own words",
  "items": [ { "section": "dna|business|positioning|needs", "label": "", "text": "one plain sentence", "excerpt": "a short verbatim phrase from the page", "source_url": "the page URL it came from" } ],
  "products": [ { "name": "", "category": "", "description": "", "features": "", "benefits": "", "problem": "", "pricing": "exactly as printed", "differentiator": "", "source_url": "" } ],
  "audiences": [ { "name": "", "description": "who the company says it is for", "demographics": "only if stated", "geography": "", "motivations": "", "pains": "", "source_url": "" } ],
  "social": "social handles or links found, comma separated"
}

RULES
- Every item needs an excerpt copied from the page and the URL of the page it was on. No excerpt, no item.
- Use "" for anything the pages do not say. An empty field is correct and is shown to the user as a gap.
- Never state a market size, share, growth rate or revenue, even if a page claims one.
- Do not write an item about competitors, the market, or trends: that is not this step.
- Use these exact labels where the pages support them:
${Object.entries(FIELDS).filter(([k]) => k !== "category").map(([k, l]) => `  ${k}: ${l.join(", ")}`).join("\n")}
- Plain British English, short sentences, no marketing language.`;
}

/* Pass 2 — the reasoning. It sees pass 1's result, never the raw pages. */
function analysePrompt(brand, ex, known) {
  const seen = [];
  if (known.labels && known.labels.length) seen.push(`Claims already on file (do not return these again): ${known.labels.slice(0, 60).join("; ")}`);
  if (known.competitors && known.competitors.length) seen.push(`Competitors already on file (do not return these again): ${known.competitors.slice(0, 40).join(", ")}`);
  if (known.sources && known.sources.length) seen.push(`Sources already used (do not return a signal from these again): ${known.sources.slice(0, 40).join(", ")}`);
  return `You are the analysis step of a marketing intelligence system. Another model has already read the brand's own website; its extraction is below. Your job is the thinking, not the reading.

BRAND
name: ${brand.name}
website: ${brand.website}
category given by the user: ${brand.category || "not given"}
market: ${ex.geography || brand.geography || "not stated"}${ex.markets ? ` (also ${ex.markets})` : ""}

WHAT THE BRAND SAYS ABOUT ITSELF (extracted from its own pages)
${JSON.stringify({ category: ex.category, items: (ex.items || []).map(i => ({ label: i.label, text: i.text })), products: (ex.products || []).map(p => ({ name: p.name, description: p.description, pricing: p.pricing })), audiences: (ex.audiences || []).map(a => ({ name: a.name, description: a.description })) })}

${seen.length ? "ALREADY ON FILE FROM EARLIER RUNS\n" + seen.join("\n") + "\nReturn only what is new or has changed since. Repeating what is listed above wastes the user's money and their attention.\n" : ""}
YOUR TASK
${process.env.RESEARCH_WEB_SEARCH === "0" ? "External research is switched off for this run. Use only the extraction above. Return no signals and no competitors unless the extraction names them." : `Research this category and market with web search (at most ${SEARCH_USES} searches — choose them well). Prefer trade press, regulators, official company pages and industry bodies.`}
Then return ONE JSON object and nothing else.

RULES THAT MATTER MORE THAN COMPLETENESS
- Never invent. If you did not retrieve a source for it, do not write it.
- Never state a market size, market share, growth rate, revenue or company size. Not even approximately.
- provenance: "observed" means a source you actually opened says it, and needs a real source_url. "ai_inferred" means your reading of the evidence, must have source_url "" and confidence "Low" or "Medium".
- Do not return an "observed" audience: who actually buys can only come from the company's own customer data, which you do not have.
- Competitors are candidates for the user to judge, never confirmed. Only name a company a source names.
- Plain British English, short declarative sentences.

JSON SHAPE
{
  "summary": "four or five sentences for the founder: what the business does, what it sells, who it serves, what problem it solves, how it appears to differentiate. Commercial reading, not a paraphrase of their homepage.",
  "items": [ { "section": "category|positioning|needs|marketing|objectives|assessment", "label": "", "text": "", "provenance": "observed|ai_inferred", "confidence": "Low|Medium|High", "source_url": "", "excerpt": "" } ],
  "competitors": [ { "name": "", "website": "", "kind": "Direct|Indirect|Emerging|Adjacent", "note": "why it competes with this brand", "why": "why you are proposing it", "positioning": "", "value_prop": "", "offering": "", "pricing": "", "audience": "", "messaging": "", "distribution": "", "differentiation": "", "strengths": "", "weaknesses": "", "hq": "", "markets": "", "source_url": "" } ],
  "signals": [ { "kind": "shift|signal|crowded|gap", "category": "consumer|competitor|category|product|regulatory", "event": "", "text": "what is happening, one sentence", "implication": "why it matters", "affects": "", "brand_meaning": "what it could mean for this brand", "excerpt": "", "source_type": "Press|Website|Report|Regulator|Review site|Forum|Other", "source_url": "", "published_at": "YYYY-MM-DD", "country": "", "confidence": "Low|Medium|High", "relevance": "Low|Medium|High", "limits": "what this evidence cannot tell us" } ]
}

Use these exact labels:
  category: ${FIELDS.category.join(", ")}
  positioning: ${FIELDS.positioning.join(", ")}
  needs: ${FIELDS.needs.join(", ")}
  marketing: ${FIELDS.marketing.join(", ")}
  objectives: use the label "Observed priority" for a priority public evidence supports, "Inferred priority" for one you are reading from the evidence, and "To validate with the founder" for a question only they can answer. Several items may share a label. Put the objective itself in "text".
  assessment: ${FIELDS.assessment.join(", ")}

ON OBJECTIVES AND ASSESSMENT, THE PART MOST SYSTEMS GET WRONG
- You cannot see their internal targets. An inferred priority is a hypothesis about what the evidence suggests they are pushing on, never their confirmed objective. Write it as one.
- "To validate with the founder" is where the honest unknowns go: anything public research cannot settle. Give at least three.
- The assessment is a reasoned read for this specific business, not a SWOT. Say where they stand, what actually looks strong, what looks fragile, and what you would look into next. If the evidence is thin, say the assessment is thin.
- Never claim to know conversion rates, ad performance, revenue or internal plans. No data source is connected.

Aim for 8 to 16 items across category, positioning and needs, 3 to 6 marketing items, 4 to 8 objectives across the three labels, all five assessment labels, 0 to 8 competitors, 0 to 10 signals. Quality over volume. Return the JSON object only.`;
}

/* ---------- validation: anything that cannot be checked is dropped, not patched ---------- */
const PROV = ["brand_stated", "observed", "ai_inferred"], CONF = ["Low", "Medium", "High"];
const SECTIONS = Object.keys(FIELDS);
function cleanItem(r, pageUrls) {
  const section = oneOf(r.section, SECTIONS, null);
  if (!section || !ok(r.label) || !ok(r.text)) return null;
  const provenance = oneOf(r.provenance, PROV, "ai_inferred");
  let source_url = isUrl(r.source_url) ? clamp(r.source_url, 400) : "";
  if (provenance === "ai_inferred") source_url = "";
  if (provenance === "brand_stated" && source_url && !pageUrls.includes(source_url)) source_url = pageUrls[0] || "";
  return { section, label: clamp(r.label, 80), text: clamp(r.text, 900), excerpt: clamp(r.excerpt, 300),
    provenance, confidence: oneOf(r.confidence, CONF, provenance === "ai_inferred" ? "Low" : "Medium"),
    source_url, status: "candidate" };
};

module.exports = async function handler(req, res) {
  if (req.method === "GET" || req.method === "HEAD") {
    const ready = !!process.env.ANTHROPIC_API_KEY;
    /* ?probe=<url> — discovery only: robots, sitemap, links, classification and one page read.
       No model call, so it costs nothing and shows exactly what the crawler can see. */
    if (req.query && req.query.probe) {
      const base = siteUrl(req.query.probe);
      if (!base) return res.status(400).json({ error: "that is not a web address" });
      const rb = await robots(base.origin);
      const home = await readPage(base.toString());
      const maps = await sitemapUrls(base, rb.sitemaps);
      const cand = new Map();
      const offer = u => { let x; try { x = new URL(u, base); } catch { return; }
        if (x.host !== base.host) return; x.hash = "";
        const key = x.toString().replace(/\/$/, "");
        if (SKIP_RE.test(x.pathname + x.search) || (x.pathname + x.search).length > 140) return;
        if (!cand.has(key)) cand.set(key, { url: x.toString(), kind: kindOf(x) }); };
      maps.urls.forEach(offer);
      if (home.ok) { const raw = await get(base.toString()); if (raw.ok) links(raw.html, home.url).forEach(offer); }
      const byKind = {}; [...cand.values()].forEach(c => { (byKind[c.kind] = byKind[c.kind] || []).push(c.url); });
      return res.status(200).json({ engine: "noetis-research", probe: base.toString(),
        robots: { found: rb.fetched, rules: rb.rules.length, sitemaps: rb.sitemaps },
        sitemap: { urls: maps.urls.length, note: maps.note },
        homepage: home.ok ? { ok: true, url: home.url, title: home.title, chars: home.text.length, via: home.via, thin: !!home.thin, sample: home.text.slice(0, 400) } : { ok: false, reason: home.reason },
        candidates: cand.size,
        byKind: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, { count: v.length, examples: v.slice(0, 3) }])),
        renderer: process.env.FIRECRAWL_API_KEY ? "firecrawl" : "none" });
    }

    /* ?check=models — one token to each routed model, to confirm this account can call them.
       Costs next to nothing and is the honest way to find out before a real run. */
    if (ready && req.query && req.query.check === "models") {
      const out = {};
      for (const [job, model] of Object.entries(MODELS)) {
        try { await call(model, { max_tokens: 1, messages: [{ role: "user", content: "ok" }] }, job); out[job] = { model, ok: true }; }
        catch (e) { out[job] = { model, ok: false, error: String(e.message || e).slice(0, 200) }; }
      }
      return res.status(200).json({ engine: "noetis-research", check: "models", routing: out });
    }
    return res.status(200).json({ engine: "noetis-research", ready, model: MODELS.analyse, models: MODELS, searchUses: SEARCH_USES,
      maxPages: MAX_PAGES, renderer: process.env.FIRECRAWL_API_KEY ? "firecrawl" : "",
      webSearch: process.env.RESEARCH_WEB_SEARCH !== "0" && SEARCH_USES > 0,
      reason: ready ? "" : "ANTHROPIC_API_KEY is not set on this deployment, so the engine cannot run." });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "POST a brand to run discovery." });

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  const say = (stage, kind, msg, write) => { res.write(JSON.stringify(write ? { stage, kind, msg, write } : { stage, kind, msg }) + "\n"); res.flush && res.flush(); };

  const brand = (req.body && req.body.brand) || {};

  /* Retry one page, for the retry action beside a failed page in the UI. */
  if (req.body && req.body.refetch && req.body.refetch.url) {
    const { url, kind } = req.body.refetch;
    const p = await readPage(url);
    say(0, p.ok ? "ok" : "warn", p.ok ? `${url} · ${p.text.length} characters` : `${url} ${p.reason}`,
      { table: "pages", row: { url: p.ok ? p.url : url, kind: kind || "Other page", status: p.ok ? (p.text.length < 400 ? "thin" : "ok") : "failed",
        title: p.title || "", chars: p.ok ? p.text.length : 0, reason: p.ok ? "" : p.reason, fetched_at: new Date().toISOString(), rendered: p.via === "rendered" } });
    return res.end();
  }

  try {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set on this deployment");
    const base = siteUrl(brand.website);
    if (!base) throw new Error(`"${brand.website || ""}" is not a web address the engine can open`);

    /* ---- stage 0: discover and crawl the brand's own site ---- */
    say(STAGE.SITE, "ok", `reading ${base.host}`);
    const rb = await robots(base.origin);
    say(STAGE.SITE, rb.fetched ? "ok" : "warn", rb.fetched
      ? `robots.txt read · ${rb.rules.length} rule${rb.rules.length === 1 ? "" : "s"} for crawlers${rb.sitemaps.length ? ` · ${rb.sitemaps.length} sitemap${rb.sitemaps.length === 1 ? "" : "s"} declared` : ""}`
      : "no robots.txt found; discovering pages from the sitemap and the homepage's own links");

    const homeRaw = await get(base.toString());
    if (!homeRaw.ok) throw new Error(`${base.host} ${homeRaw.reason}`);
    const home = homeRaw, homeRead = await readPage(base.toString());
    const homeUrl = homeRead.ok ? homeRead.url : (home.url || base.toString());

    /* Candidates come from what the site publishes, never from guessed paths. */
    const cand = new Map();
    const offer = (u, via) => { let x; try { x = new URL(u, homeUrl); } catch { return; }
      if (x.host !== base.host || !/^https?:$/.test(x.protocol)) return;
      x.hash = ""; const key = x.toString().replace(/\/$/, "");
      if (key === homeUrl.replace(/\/$/, "")) return;
      if (SKIP_RE.test(x.pathname + x.search)) return;
      if ((x.pathname + x.search).length > 140) return;
      if (!cand.has(key)) cand.set(key, { url: x.toString(), kind: kindOf(x), via });
    };

    const maps = await sitemapUrls(base, rb.sitemaps);
    maps.urls.forEach(u => offer(u, "sitemap"));
    say(STAGE.SITE, maps.urls.length ? "ok" : "skip", maps.urls.length
      ? `sitemap read · ${maps.urls.length} page${maps.urls.length === 1 ? "" : "s"} published${maps.note ? " · " + maps.note : ""}`
      : `no sitemap found${maps.note ? " · " + maps.note : ""}; using the homepage's links instead`);

    const fromHome = links(home.html, homeUrl);
    fromHome.forEach(u => offer(u, "homepage link"));
    say(STAGE.SITE, "ok", `homepage read · ${fromHome.length} internal links · ${cand.size} candidate page${cand.size === 1 ? "" : "s"} after filtering`);

    /* Pick a spread: the best few of each kind the site actually has. */
    const picked = [], quota = Object.fromEntries(KINDS.map(([n, , q]) => [n, q]));
    const score = c => (c.via === "sitemap" ? 0 : 1) + c.url.split("/").length * 0.1;
    for (const [name] of KINDS) {
      const l = [...cand.values()].filter(c => c.kind === name).sort((a, c) => score(a) - score(c));
      for (const c of l.slice(0, quota[name])) if (picked.length < MAX_PAGES - 1) picked.push(c);
    }
    if (picked.length < MAX_PAGES - 1)
      for (const c of [...cand.values()].filter(c => c.kind === "Other page").sort((a, c2) => score(a) - score(c2)))
        if (picked.length < MAX_PAGES - 1) picked.push(c);

    const pageRow = (url, kind, st, extra) => ({ table: "pages", row: { url, kind, status: st, fetched_at: new Date().toISOString(), ...extra } });
    const pages = [{ name: "Homepage", url: homeUrl, text: homeRead.ok ? homeRead.text : textOf(home.html), title: homeRead.ok ? homeRead.title : titleOf(home.html) }];
    say(STAGE.SITE, "ok", `homepage · ${pages[0].title || "no title"} · ${pages[0].text.length} characters`, pageRow(homeUrl, "Homepage", pages[0].text.length < 400 ? "thin" : "ok", { title: pages[0].title, chars: pages[0].text.length, via: "the address you gave", rendered: homeRead.via === "rendered" }));

    for (const c of picked) {
      const path = new URL(c.url).pathname;
      if (!robotsAllows(rb.rules, path)) { say(STAGE.SITE, "skip", `${path} · robots.txt asks crawlers not to read it`, pageRow(c.url, c.kind, "skipped", { reason: "robots.txt disallows it", via: c.via })); continue; }
      const p = await readPage(c.url);
      if (!p.ok) { say(STAGE.SITE, "warn", `${path} ${p.reason}`, pageRow(c.url, c.kind, "failed", { reason: p.reason, http_status: p.status || null, via: c.via })); continue; }
      pages.push({ name: c.kind, url: p.url, text: p.text, title: p.title });
      say(STAGE.SITE, p.thin ? "warn" : "ok", `${c.kind.toLowerCase()} · ${p.title || path} · ${p.text.length} characters${p.via === "rendered" ? " (rendered)" : ""}${p.thin ? " — almost empty" : ""}`,
        pageRow(p.url, c.kind, p.thin ? "thin" : "ok", { title: p.title, chars: p.text.length, via: c.via, reason: p.thin ? "Returned almost no text; the page is probably built in the browser" : "", rendered: p.via === "rendered" }));
    }
    const thin = pages.filter(p => p.text.length < 400);
    if (pages.length === 1) say(STAGE.SITE, "warn", "only the homepage could be read, so the profile will be thin");
    if (thin.length) say(STAGE.SITE, "warn", `${thin.length} page${thin.length === 1 ? "" : "s"} returned almost no text — likely rendered by JavaScript. ${process.env.FIRECRAWL_API_KEY ? "" : "A rendering crawler (set FIRECRAWL_API_KEY) would read these."}`);

    /* ---- stage 1: read the pages (cheap model), then think about them (better model) ---- */
    const chars = pages.reduce((t, p) => t + p.text.length, 0);
    say(STAGE.PRODUCTS, "ok", `reading ${chars.toLocaleString()} characters with ${MODELS.extract} — the cheapest model that can do literal extraction`);
    const ex = asJson((await call(MODELS.extract, { max_tokens: 6000, messages: [{ role: "user", content: extractPrompt(brand, pages) }] }, "extraction")).text, "extraction");

    const known = (req.body && req.body.known) || {};
    say(STAGE.AUDIENCE, "ok", `the next five stages come from one analysis call, so they complete together`);
    say(STAGE.AUDIENCE, "ok", process.env.RESEARCH_WEB_SEARCH === "0"
      ? `analysing with ${MODELS.analyse} · external research is off, so the site alone`
      : `analysing with ${MODELS.analyse} · up to ${SEARCH_USES} web searches${known.labels && known.labels.length ? ` · ${known.labels.length} claims already on file are excluded` : ""}`);
    const aBody = { max_tokens: 8000, messages: [{ role: "user", content: analysePrompt(brand, ex, known) }] };
    if (process.env.RESEARCH_WEB_SEARCH !== "0" && SEARCH_USES > 0) aBody.tools = [{ type: WEB_SEARCH_TOOL, name: "web_search", max_uses: SEARCH_USES }];
    let an;
    try { an = asJson((await call(MODELS.analyse, aBody, "analysis")).text, "analysis"); }
    catch (e) {
      if (e.status !== 400 || !aBody.tools) throw e;
      say(STAGE.AUDIENCE, "warn", "external research is unavailable on this account, so the profile is built from the site alone");
      delete aBody.tools;
      an = asJson((await call(MODELS.analyse, aBody, "analysis")).text, "analysis");
    }

    /* Pass 1 says only what the brand says; pass 2 adds what the world says. */
    const out = {
      brand: { geography: ex.geography, markets: ex.markets, category: ex.category },
      items: [...(ex.items || []).map(i => ({ ...i, provenance: "brand_stated", confidence: "High" })), ...(an.items || [])],
      products: (ex.products || []).map(p => ({ ...p, provenance: "brand_stated" })),
      audiences: (ex.audiences || []).map(a => ({ ...a, kind: "intended", provenance: "brand_stated" })),
      competitors: an.competitors || [], signals: an.signals || []
    };
    if (ok(ex.social)) out.items.push({ section: "business", label: "Social presence", text: ex.social, provenance: "brand_stated", confidence: "High", source_url: pages[0].url, excerpt: "" });
    const pageUrls = pages.map(p => p.url);

    const bUpd = {};
    if (ok(out.brand && out.brand.geography) && !ok(brand.geography)) bUpd.geography = clamp(out.brand.geography, 80);
    if (ok(out.brand && out.brand.markets)) bUpd.markets = clamp(out.brand.markets, 160);
    if (ok(an.summary)) bUpd.summary = clamp(an.summary, 1400);
    if (Object.keys(bUpd).length) say(STAGE.BUSINESS, "ok", bUpd.summary ? "brand summary written" : `market read from the site: ${bUpd.geography || brand.geography}`, { table: "brands", row: bUpd });

    const counts = {};
    for (const raw of (out.items || [])) {
      const row = cleanItem(raw, pageUrls); if (!row) continue;
      const st = SECTION_STAGE[row.section] != null ? SECTION_STAGE[row.section] : STAGE.BUSINESS;
      counts[st] = (counts[st] || 0) + 1;
      say(st, "ok", `${row.label.toLowerCase()} — ${row.provenance.replace("_", " ")}`, { table: "brand_profile_items", row });
    }
    for (const [st, label] of [[STAGE.BUSINESS, "the business"], [STAGE.AUDIENCE, "the audience"], [STAGE.POSITIONING, "positioning"], [STAGE.MARKET, "the market"], [STAGE.MARKETING, "marketing presence"], [STAGE.SYNTHESIS, "objectives and assessment"]])
      say(st, counts[st] ? "ok" : "warn", counts[st] ? `${counts[st]} findings about ${label}` : `nothing could be established about ${label} from what is public`);

    for (const p of (out.products || [])) {
      if (!ok(p.name)) continue;
      say(STAGE.PRODUCTS, "ok", `product: ${clamp(p.name, 60)}`, { table: "products_services", row: {
        name: clamp(p.name, 120), category: clamp(p.category, 80), description: clamp(p.description, 600), features: clamp(p.features, 400),
        benefits: clamp(p.benefits, 400), problem: clamp(p.problem, 400), pricing: clamp(p.pricing, 160), differentiator: clamp(p.differentiator, 400),
        provenance: oneOf(p.provenance, PROV, "brand_stated"), source_url: isUrl(p.source_url) ? clamp(p.source_url, 400) : "" } });
    }
    for (const a of (out.audiences || [])) {
      if (!ok(a.description)) continue;
      say(STAGE.AUDIENCE, "ok", `intended audience: ${clamp(a.name || a.description, 60)}`, { table: "audience_profiles", row: {
        kind: "intended", name: clamp(a.name, 80), description: clamp(a.description, 600), demographics: clamp(a.demographics, 300),
        geography: clamp(a.geography, 200), motivations: clamp(a.motivations, 400), pains: clamp(a.pains, 400), triggers: clamp(a.triggers, 400),
        objections: clamp(a.objections, 400), behaviour: clamp(a.behaviour, 400), basis: "",
        provenance: oneOf(a.provenance, PROV, "ai_inferred"), source_url: isUrl(a.source_url) ? clamp(a.source_url, 400) : "" } });
    }
    say(STAGE.AUDIENCE, "warn", "who actually buys is still unknown: that can only come from your own customer data");

    /* ---- competitors, as candidates: part of market context ---- */
    const comps = (out.competitors || []).filter(c => ok(c.name));
    for (const c of comps) {
      say(STAGE.MARKET, "ok", `candidate: ${clamp(c.name, 60)}`, { table: "competitors", row: {
        name: clamp(c.name, 120), website: clamp(c.website, 200), category: clamp(c.category, 120),
        kind: oneOf(c.kind, ["Direct", "Indirect", "Emerging", "Adjacent"], "Direct"), status: "candidate",
        note: clamp(c.note, 400), why: clamp(c.why, 300), positioning: clamp(c.positioning, 300), value_prop: clamp(c.value_prop, 300),
        offering: clamp(c.offering, 300), pricing: clamp(c.pricing, 160), audience: clamp(c.audience, 200), messaging: clamp(c.messaging, 300),
        distribution: clamp(c.distribution, 200), differentiation: clamp(c.differentiation, 300), strengths: clamp(c.strengths, 300),
        weaknesses: clamp(c.weaknesses, 300), hq: clamp(c.hq, 80), markets: clamp(c.markets, 200),
        source_url: isUrl(c.source_url) ? clamp(c.source_url, 400) : "", placed_by: "engine" } });
    }
    say(STAGE.MARKET, comps.length ? "ok" : "skip", comps.length ? `${comps.length} candidate${comps.length === 1 ? "" : "s"} — none enters the competitive set until you confirm it` : "no competitor could be named from a source");

    /* ---- stage 3: signals ---- */
    const sigs = (out.signals || []).filter(s => ok(s.text));
    for (const s of sigs) {
      const provenance = isUrl(s.source_url) ? "observed" : "ai_inferred";
      say(STAGE.MARKET, "ok", clamp(s.text, 90), { table: "market_signals", row: {
        kind: oneOf(s.kind, ["shift", "signal", "crowded", "gap"], "signal"),
        category: oneOf(s.category, ["consumer", "competitor", "category", "product", "regulatory"], "category"),
        event: clamp(s.event, 60), text: clamp(s.text, 500), implication: clamp(s.implication, 400), affects: clamp(s.affects, 300),
        brand_meaning: clamp(s.brand_meaning, 400), excerpt: clamp(s.excerpt, 300), source_type: clamp(s.source_type, 40) || "Other",
        source_url: isUrl(s.source_url) ? clamp(s.source_url, 400) : "", published_at: isDate(s.published_at) ? s.published_at : null,
        country: clamp(s.country, 60), confidence: oneOf(s.confidence, CONF, "Low"), relevance: oneOf(s.relevance, CONF, "Medium"),
        limits: clamp(s.limits, 300), provenance } });
    }
    say(STAGE.MARKET, sigs.length ? "ok" : "skip", sigs.length ? `${sigs.length} signal${sigs.length === 1 ? "" : "s"} with a source` : "no sourced signal was found for this category");

    say(STAGE.SYNTHESIS, "skip", "Opportunities are framed by a person from this evidence. Nothing is framed automatically.");
    say(STAGE.SYNTHESIS, "ok", `routing: ${MODELS.extract} read the pages, ${MODELS.analyse} did the analysis. Opus was not used.`);
    res.end();
  } catch (e) {
    say(STAGE.SITE, "warn", `Run failed: ${e.message || e}`);
    res.end();
  }
};
