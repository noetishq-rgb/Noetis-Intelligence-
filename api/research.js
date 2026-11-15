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

   Environment:
     ANTHROPIC_API_KEY   required
     RESEARCH_MODEL      optional, defaults below
     RESEARCH_WEB_SEARCH optional, "0" turns off external research and reads only the brand's site

   What it will not do: invent a fact to fill a gap, state a market size or share, or return a
   source URL it did not actually retrieve. Empty is a valid answer and is filed as a gap.
*/

const MODEL = process.env.RESEARCH_MODEL || "claude-sonnet-4-5";
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
const FIELDS = {
  dna: ["Purpose", "Mission", "Vision", "Brand promise", "Values", "Personality", "Tone of voice", "Messaging pillars", "Visual identity"],
  business: ["What the business is", "Business model", "Revenue model", "Problem it solves", "Business objectives", "Growth priority", "Business stage", "Distribution", "Channels in use", "Social presence"],
  positioning: ["Positioning statement", "Value proposition", "Differentiators", "Price position", "Perceived strengths", "Perceived weaknesses", "Messaging consistency", "Positioning gaps", "Repositioning to consider"],
  needs: ["Customer needs", "Motivations", "Pain points", "Purchase triggers", "Objections", "Buying behaviour"],
  category: ["Market overview", "Category developments", "Consumer behaviour shifts", "Industry trends", "Demand patterns", "Pricing movements", "Regulatory or technology change", "Geographic differences"]
};

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

/* ---------- the research call ---------- */
function prompt(brand, pages) {
  const site = pages.map(p => `### ${p.name} — ${p.url}\n${p.text || "(nothing readable)"}`).join("\n\n");
  return `You are the research step of a marketing intelligence system. You are building the first profile of one brand.

BRAND
name: ${brand.name}
website: ${brand.website}
category given by the user: ${brand.category || "not given"}
market given by the user: ${brand.geography || "not given"}

PAGES RETRIEVED FROM THE BRAND'S OWN SITE
${site || "(no page could be read)"}

YOUR TASK
1. Read the pages above and record what the brand itself says.
2. Research the category and market from external sources${process.env.RESEARCH_WEB_SEARCH === "0" ? " — web search is disabled for this run, so skip this step and return no signals or competitors unless the brand's own pages name them" : " using web search. Prefer trade press, regulators, official company pages and industry bodies"}.
3. Return ONE JSON object and nothing else. No markdown fence, no commentary.

RULES THAT MATTER MORE THAN COMPLETENESS
- Never invent. If something is not on the pages and not in a source you actually retrieved, return "" for it. An empty field is a correct answer and is shown to the user as a gap.
- Never state a market size, market share, growth rate, revenue, or company size. Not even "approximately". Leave them out entirely.
- provenance must be exactly one of: "brand_stated" (the brand's own site says it), "observed" (an external source you retrieved says it), "ai_inferred" (your reading of the evidence, no single source states it).
- Every "brand_stated" item needs an "excerpt": a short verbatim phrase from the page, and a source_url that is one of the page URLs above.
- Every "observed" item needs a real source_url you actually retrieved, and published_at where the source shows a date. Never write a URL you did not open.
- "ai_inferred" items must have source_url "" and confidence "Low" or "Medium". Do not dress up a guess as a finding.
- Audiences: an audience the brand says it is for is kind "intended". Do NOT return an "observed" audience: who actually buys can only come from the company's own customer data, which you do not have.
- Competitors: only companies you can name from a source. Each is a candidate for the user to judge, never a confirmed competitor.
- Write in plain British English, in short declarative sentences. No marketing language, no adjectives doing work facts should do.

JSON SHAPE
{
  "brand": { "geography": "primary country of operation, if the site shows it", "markets": "other markets, comma separated", "category": "the category in the brand's own terms, if clearer than the one given" },
  "items": [ { "section": "dna|business|positioning|needs|category", "label": "", "text": "", "excerpt": "", "provenance": "", "confidence": "Low|Medium|High", "source_url": "" } ],
  "products": [ { "name": "", "category": "", "description": "", "features": "", "benefits": "", "problem": "", "pricing": "", "differentiator": "", "provenance": "", "source_url": "" } ],
  "audiences": [ { "kind": "intended", "name": "", "description": "", "demographics": "", "geography": "", "motivations": "", "pains": "", "triggers": "", "objections": "", "behaviour": "", "provenance": "", "source_url": "" } ],
  "competitors": [ { "name": "", "website": "", "kind": "Direct|Indirect|Emerging|Adjacent", "note": "why it competes with this brand", "why": "why you are proposing it", "positioning": "", "value_prop": "", "offering": "", "pricing": "", "audience": "", "messaging": "", "distribution": "", "differentiation": "", "strengths": "", "weaknesses": "", "hq": "", "markets": "", "source_url": "" } ],
  "signals": [ { "kind": "shift|signal|crowded|gap", "category": "consumer|competitor|category|product|regulatory", "event": "", "text": "what is happening, one sentence", "implication": "why it matters", "affects": "what it affects", "brand_meaning": "what it could mean for this brand", "excerpt": "", "source_type": "Press|Website|Report|Regulator|Review site|Forum|Other", "source_url": "", "published_at": "YYYY-MM-DD", "country": "", "confidence": "Low|Medium|High", "relevance": "Low|Medium|High", "limits": "what this evidence cannot tell us" } ]
};

USE THESE EXACT LABELS where you have something to say; they are the rows of the user's brand profile. Skip any you cannot support.
${Object.entries(FIELDS).map(([s, l]) => `${s}: ${l.join(", ")}`).join("\n")}

Aim for quality over volume: 12 to 25 items, 0 to 8 products, 1 to 3 intended audiences, 0 to 8 competitors, 0 to 10 signals. Return the JSON object only.`;
};

async function research(brand, pages, say) {
  const key = process.env.ANTHROPIC_API_KEY;
  const body = {
    model: MODEL, max_tokens: 8000,
    messages: [{ role: "user", content: prompt(brand, pages) }]
  };
  const useSearch = process.env.RESEARCH_WEB_SEARCH !== "0";
  if (useSearch) body.tools = [{ type: WEB_SEARCH_TOOL, name: "web_search", max_uses: 8 }];

  let res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }, body: JSON.stringify(body)
  });
  if (!res.ok && useSearch && res.status === 400) {
    const detail = await res.text();
    say(1, "warn", "External research is unavailable on this account, so only the brand's own site was read.");
    delete body.tools;
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }, body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`the model API answered ${res.status}: ${(detail || "").slice(0, 300)}`);
  }
  if (!res.ok) throw new Error(`the model API answered ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const data = await res.json();
  const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("").trim();
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("the model did not return JSON");
  return JSON.parse(text.slice(start, end + 1));
};

/* ---------- validation: anything that cannot be checked is dropped, not patched ---------- */
const PROV = ["brand_stated", "observed", "ai_inferred"], CONF = ["Low", "Medium", "High"];
function cleanItem(r, pageUrls) {
  const section = oneOf(r.section, Object.keys(FIELDS), null);
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
    return res.status(200).json({ engine: "noetis-research", ready, model: MODEL,
      webSearch: process.env.RESEARCH_WEB_SEARCH !== "0",
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
    say(0, "ok", `reading ${base.host}`);
    const rb = await robots(base.origin);
    say(0, rb.fetched ? "ok" : "warn", rb.fetched ? `robots.txt read · ${rb.rules.length} rule${rb.rules.length === 1 ? "" : "s"} for crawlers` : "no robots.txt found; reading only the pages linked from the homepage");

    const home = await get(base.toString());
    if (!home.ok) throw new Error(`${base.host} ${home.reason}`);
    const pages = [{ name: "Homepage", url: home.url || base.toString(), text: textOf(home.html) }];
    say(0, "ok", `homepage read · ${pages[0].text.length} characters of text`);

    const links = pickLinks(home.html, base);
    for (const [name] of WANTED.slice(1)) {
      if (pages.length >= MAX_PAGES) break;
      const url = links.get(name);
      if (!url) { say(0, "skip", `${name.toLowerCase()} page: no link found on the homepage`); continue; }
      const path = new URL(url).pathname;
      if (!robotsAllows(rb.rules, path)) { say(0, "skip", `${name.toLowerCase()} page: robots.txt asks crawlers not to read ${path}`); continue; }
      const p = await get(url);
      if (!p.ok) { say(0, "warn", `${name.toLowerCase()} page ${p.reason} — nothing taken from it`); continue; }
      const text = textOf(p.html);
      pages.push({ name, url: p.url || url, text });
      say(0, "ok", `${name.toLowerCase()} page read · ${text.length} characters`);
    }
    if (pages.length === 1) say(0, "warn", "only the homepage could be read, so the profile will be thin");

    /* ---- stage 1: profile ---- */
    say(1, "ok", process.env.RESEARCH_WEB_SEARCH === "0" ? "building the profile from the site alone (external research is off)" : "reading the pages and researching the category");
    const out = await research(brand, pages, say);
    const pageUrls = pages.map(p => p.url);

    const bUpd = {};
    if (ok(out.brand && out.brand.geography) && !ok(brand.geography)) bUpd.geography = clamp(out.brand.geography, 80);
    if (ok(out.brand && out.brand.markets)) bUpd.markets = clamp(out.brand.markets, 160);
    if (Object.keys(bUpd).length) say(1, "ok", `market read from the site: ${bUpd.geography || brand.geography}${bUpd.markets ? " · also " + bUpd.markets : ""}`, { table: "brands", row: bUpd });

    let n = 0;
    for (const raw of (out.items || [])) {
      const row = cleanItem(raw, pageUrls); if (!row) continue;
      n++; say(1, "ok", `${row.label.toLowerCase()} — ${row.provenance.replace("_", " ")}`, { table: "brand_profile_items", row });
    }
    say(1, n ? "ok" : "warn", n ? `${n} claims filed, each as a candidate for your review` : "nothing could be established from the pages read");

    for (const p of (out.products || [])) {
      if (!ok(p.name)) continue;
      say(1, "ok", `product: ${clamp(p.name, 60)}`, { table: "products_services", row: {
        name: clamp(p.name, 120), category: clamp(p.category, 80), description: clamp(p.description, 600), features: clamp(p.features, 400),
        benefits: clamp(p.benefits, 400), problem: clamp(p.problem, 400), pricing: clamp(p.pricing, 160), differentiator: clamp(p.differentiator, 400),
        provenance: oneOf(p.provenance, PROV, "brand_stated"), source_url: isUrl(p.source_url) ? clamp(p.source_url, 400) : "" } });
    }
    for (const a of (out.audiences || [])) {
      if (!ok(a.description)) continue;
      say(1, "ok", `intended audience: ${clamp(a.name || a.description, 60)}`, { table: "audience_profiles", row: {
        kind: "intended", name: clamp(a.name, 80), description: clamp(a.description, 600), demographics: clamp(a.demographics, 300),
        geography: clamp(a.geography, 200), motivations: clamp(a.motivations, 400), pains: clamp(a.pains, 400), triggers: clamp(a.triggers, 400),
        objections: clamp(a.objections, 400), behaviour: clamp(a.behaviour, 400), basis: "",
        provenance: oneOf(a.provenance, PROV, "ai_inferred"), source_url: isUrl(a.source_url) ? clamp(a.source_url, 400) : "" } });
    }
    say(1, "warn", "who actually buys is still unknown: that can only come from your own customer data");

    /* ---- stage 2: competitors, as candidates ---- */
    const comps = (out.competitors || []).filter(c => ok(c.name));
    for (const c of comps) {
      say(2, "ok", `candidate: ${clamp(c.name, 60)}`, { table: "competitors", row: {
        name: clamp(c.name, 120), website: clamp(c.website, 200), category: clamp(c.category, 120),
        kind: oneOf(c.kind, ["Direct", "Indirect", "Emerging", "Adjacent"], "Direct"), status: "candidate",
        note: clamp(c.note, 400), why: clamp(c.why, 300), positioning: clamp(c.positioning, 300), value_prop: clamp(c.value_prop, 300),
        offering: clamp(c.offering, 300), pricing: clamp(c.pricing, 160), audience: clamp(c.audience, 200), messaging: clamp(c.messaging, 300),
        distribution: clamp(c.distribution, 200), differentiation: clamp(c.differentiation, 300), strengths: clamp(c.strengths, 300),
        weaknesses: clamp(c.weaknesses, 300), hq: clamp(c.hq, 80), markets: clamp(c.markets, 200),
        source_url: isUrl(c.source_url) ? clamp(c.source_url, 400) : "", placed_by: "engine" } });
    }
    say(2, comps.length ? "ok" : "skip", comps.length ? `${comps.length} candidate${comps.length === 1 ? "" : "s"} — none enters the competitive set until you confirm it` : "no competitor could be named from a source");

    /* ---- stage 3: signals ---- */
    const sigs = (out.signals || []).filter(s => ok(s.text));
    for (const s of sigs) {
      const provenance = isUrl(s.source_url) ? "observed" : "ai_inferred";
      say(3, "ok", clamp(s.text, 90), { table: "market_signals", row: {
        kind: oneOf(s.kind, ["shift", "signal", "crowded", "gap"], "signal"),
        category: oneOf(s.category, ["consumer", "competitor", "category", "product", "regulatory"], "category"),
        event: clamp(s.event, 60), text: clamp(s.text, 500), implication: clamp(s.implication, 400), affects: clamp(s.affects, 300),
        brand_meaning: clamp(s.brand_meaning, 400), excerpt: clamp(s.excerpt, 300), source_type: clamp(s.source_type, 40) || "Other",
        source_url: isUrl(s.source_url) ? clamp(s.source_url, 400) : "", published_at: isDate(s.published_at) ? s.published_at : null,
        country: clamp(s.country, 60), confidence: oneOf(s.confidence, CONF, "Low"), relevance: oneOf(s.relevance, CONF, "Medium"),
        limits: clamp(s.limits, 300), provenance } });
    }
    say(3, sigs.length ? "ok" : "skip", sigs.length ? `${sigs.length} signal${sigs.length === 1 ? "" : "s"} with a source` : "no sourced signal was found for this category");

    /* ---- stage 4 ---- */
    say(4, "skip", "Opportunities are framed by a person from this evidence. Nothing is framed automatically.");
    res.end();
  } catch (e) {
    say(0, "warn", `Run failed: ${e.message || e}`);
    res.end();
  }
};
