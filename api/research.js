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
const MAX_PAGES = 6, PAGE_BYTES = 900_000, PAGE_CHARS = 9000, FETCH_MS = 15_000;

/* The pages worth reading, and the words that identify each one. */
const WANTED = [
  ["Homepage", []],
  ["About", ["about", "story", "who-we-are", "our-story", "mission"]],
  ["Products and services", ["product", "shop", "range", "collection", "service", "catalog", "catalogue"]],
  ["Pricing", ["pricing", "price", "plans", "subscribe"]],
  ["FAQ", ["faq", "help", "support", "questions"]],
  ["Contact", ["contact", "stockist", "store-locator", "find-us"]]
];

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

async function get(url, { timeout = FETCH_MS } = {}) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: "follow", headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,text/plain;q=0.9" } });
    const type = res.headers.get("content-type") || "";
    if (!res.ok) return { ok: false, status: res.status, reason: `answered ${res.status}` };
    if (!/text\/html|text\/plain|application\/xhtml/i.test(type)) return { ok: false, status: res.status, reason: `is ${type.split(";")[0] || "not a web page"}` };
    const buf = await res.arrayBuffer();
    if (buf.byteLength > PAGE_BYTES) return { ok: false, status: res.status, reason: "is too large to read" };
    return { ok: true, status: res.status, url: res.url, html: new TextDecoder("utf-8").decode(buf) };
  } catch (e) {
    return { ok: false, reason: e.name === "AbortError" ? "timed out" : (e.message || "could not be reached") };
  } finally { clearTimeout(t); }
};

/* robots.txt, read for the * group only. A Disallow we match means we do not fetch the page. */
async function robots(origin) {
  const r = await get(origin + "/robots.txt", { timeout: 6000 });
  if (!r.ok) return { rules: [], fetched: false };
  const rules = []; let inStar = false;
  for (const raw of r.html.split("\n")) {
    const line = raw.split("#")[0].trim(); if (!line) continue;
    const [kRaw, ...rest] = line.split(":"); const k = kRaw.trim().toLowerCase(), v = rest.join(":").trim();
    if (k === "user-agent") inStar = v === "*";
    else if (inStar && (k === "allow" || k === "disallow") && v) rules.push({ allow: k === "allow", path: v });
  }
  return { rules, fetched: true };
};
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

/* Same-site links only, one best candidate per wanted page type. */
function pickLinks(html, base) {
  const found = new Map();
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>/gi)) {
    let u; try { u = new URL(m[1], base); } catch { continue; }
    if (u.host !== base.host || !/^https?:$/.test(u.protocol)) continue;
    u.hash = ""; const path = (u.pathname + u.search).toLowerCase();
    if (path.length > 120) continue;
    for (const [name, keys] of WANTED) {
      if (!keys.length || found.has(name)) continue;
      if (keys.some(k => path.includes(k))) found.set(name, u.toString());
    }
  }
  return found;
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
      webSearch: process.env.RESEARCH_WEB_SEARCH !== "0" && SEARCH_USES > 0,
      reason: ready ? "" : "ANTHROPIC_API_KEY is not set on this deployment, so the engine cannot run." });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "POST a brand to run discovery." });

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  const say = (stage, kind, msg, write) => { res.write(JSON.stringify(write ? { stage, kind, msg, write } : { stage, kind, msg }) + "\n"); res.flush && res.flush(); };

  const brand = (req.body && req.body.brand) || {};
  try {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set on this deployment");
    const base = siteUrl(brand.website);
    if (!base) throw new Error(`"${brand.website || ""}" is not a web address the engine can open`);

    /* ---- stage 0: the brand's own site ---- */
    say(STAGE.SITE, "ok", `reading ${base.host}`);
    const rb = await robots(base.origin);
    say(STAGE.SITE, rb.fetched ? "ok" : "warn", rb.fetched ? `robots.txt read · ${rb.rules.length} rule${rb.rules.length === 1 ? "" : "s"} for crawlers` : "no robots.txt found; reading only the pages linked from the homepage");

    const home = await get(base.toString());
    if (!home.ok) throw new Error(`${base.host} ${home.reason}`);
    const pages = [{ name: "Homepage", url: home.url || base.toString(), text: textOf(home.html) }];
    say(STAGE.SITE, "ok", `homepage read · ${pages[0].text.length} characters of text`);

    const links = pickLinks(home.html, base);
    for (const [name] of WANTED.slice(1)) {
      if (pages.length >= MAX_PAGES) break;
      const url = links.get(name);
      if (!url) { say(STAGE.SITE, "skip", `${name.toLowerCase()} page: no link found on the homepage`); continue; }
      const path = new URL(url).pathname;
      if (!robotsAllows(rb.rules, path)) { say(STAGE.SITE, "skip", `${name.toLowerCase()} page: robots.txt asks crawlers not to read ${path}`); continue; }
      const p = await get(url);
      if (!p.ok) { say(STAGE.SITE, "warn", `${name.toLowerCase()} page ${p.reason} — nothing taken from it`); continue; }
      const text = textOf(p.html);
      pages.push({ name, url: p.url || url, text });
      say(STAGE.SITE, "ok", `${name.toLowerCase()} page read · ${text.length} characters`);
    }
    if (pages.length === 1) say(STAGE.SITE, "warn", "only the homepage could be read, so the profile will be thin");

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
