# NOETIS Intelligence

A brand and growth intelligence workspace: understand the competitive landscape, understand the
brand, identify the opportunity, develop the strategy.

The whole application is one self-contained file, [`index.html`](index.html). It has no build step
and no dependencies to install. Open it in a browser, or host it anywhere that serves a static file.

## The four modules

| Module | What it answers |
| --- | --- |
| **Brand & Market Intelligence** | What do we actually know, and how do we know it? Nine sections — overview, website intelligence, brand DNA, business model, products and services, audience, positioning, market intelligence, sources and evidence — every claim carrying its source, excerpt, confidence and verification status. |
| **Competitive Intelligence** | Where does the brand stand? Competitor discovery, directory and profiles, positioning map, white-space and coverage analysis, side-by-side comparison, a filterable signal feed and an interactive globe. |
| **Opportunity Signals** | Where could the brand move next? Emerging signals, an opportunity feed in six categories, a transparent five-dimension assessment, a drag-to-reassess prioritisation matrix, validation experiments and a handoff to Growth Strategy. |
| **Growth Strategy** | How do we act on it? A strategy builder that starts from an accepted opportunity, a twelve-part strategy canvas, and a Meta workspace. |

Every screen uses the same architecture: global navigation on the far left, the module's controls
and filters beside it, and the intelligence canvas on the right.

## Module 01 — Brand & Market Intelligence

The first module, and the one every other module reads from. A brand is onboarded once and that
understanding is reused everywhere.

**Onboarding** runs in six steps — brand identification, business understanding, audience,
positioning, marketing ecosystem, then review and confirm — one question at a time, with the
reason for each question stated on screen. Every question can be skipped, and a skipped question is
recorded as unknown rather than guessed at. The draft is saved as you type and survives closing the
page.

**Website intelligence** lists the six pages a discovery engine would read — homepage, about,
product and service, pricing, FAQ, contact — and what was extracted from each. Pages that returned
nothing say so, and anything can be entered by hand against the page it came from.

**The canvas** holds the brand's expected fields rather than a free list, so a gap is visible as a
gap: a field with nothing on file reads *Not on file* and offers to be filled, and the overview
counts what is still empty in each section. Products carry features, benefits, pricing, the problem
they solve and what makes them different. Intended and observed audiences are kept apart and never
merged, each with demographics, geography, motivations, pains, triggers, objections and behaviour.

**Market research** is requested from the left panel — topic, category, geography, segment, time
period and focus — and each finding answers five questions: what is happening, what evidence
supports it, why it matters, what it affects, and what it could mean for this brand. The evidence
expands to the source, the sample, the excerpt and the limits of that evidence. With no research
engine connected the request is recorded and nothing is fetched; nothing is invented to fill it.

**Interactions**: add and switch brands, search within the brand profile, confirm or reject what was
extracted, add information by hand, add and remove sources, filter the evidence table by
verification status, expand findings, re-run discovery, and export the whole brand intelligence
report as text with its provenance intact.

## Module 02 — Competitive Intelligence

Built on the brand profile from module 01. Nothing is asked for twice: category, markets,
products, audience, positioning and objective all come from there, and discovery states on screen
exactly which of them it is searching against.

**Discovery** keeps candidates apart from the confirmed set. Anything suggested — by the engine, by
a signal that names a company, or by you — arrives as a candidate with the reason it came up, and
only a person moves it into the competitive set. Companies are marked direct, indirect, emerging or
adjacent, and one ruled out stays on file as ruled out rather than being deleted and suggested
again.

**Profiles** carry website, category, positioning, value proposition, products, pricing where it is
public, audience, messaging, distribution, differentiation, apparent strengths and weaknesses, head
office and markets — each with its source, retrieval date and verification status, and the
developments on file about that company. No market share, ranking or revenue appears anywhere in
the module, because no source on file supports one.

**The positioning map** is drawn on dimensions you choose and can rename, because the dimensions
that decide a purchase differ by category. Inferred placements are drawn dashed and can be dragged;
dragging one makes it yours. Discs that would overlap are relaxed apart for legibility with a leader
line back to the true position — the stored judgement is never moved by the layout.

**White-space analysis** answers ten questions for any territory, including who currently addresses
it and who does not adequately, both from evidence. Beside it, coverage analysis checks every need,
product, segment and messaging territory in the brand profile against what each competitor
publishes, and reports where competitor records are silent — stated as silence, never as proven
demand. The screen opens by saying so: an absence of evidence is not an absence of competition.

**The signal feed** holds every development with its headline, competitor, date, event type, source,
excerpt, limits, confidence, relevance and implication. Filter by competitor, event type, subject,
geography, period and relevance; save what matters, dismiss what does not (dismissed is hidden,
never deleted), and investigate any one in a side panel.

**Comparison** puts the brand's own column first and compares up to any number of competitors across
eleven dimensions, marking the rows that actually differ and computing the executive summary from
the records rather than writing one.

**The globe** plots located signals, rotates, zooms, and takes a country search or a region filter;
selecting a region reports what is on file there and which competitors list that market.

## Module 03 — Opportunity Signals

Turns what the first two modules found into decisions. Every opportunity carries the evidence it
rests on, and nothing moves on its own.

**Categories.** Six: consumer, product and service, market, competitive, marketing and growth, and
technology and industry, each with its own types. Filter by category, type, geography, audience,
product, impact, feasibility, urgency, evidence confidence, horizon and status, search across them,
and sort by team priority, composite score, date or any single assessment.

**States.** New, investigating, prioritised, accepted, in progress, completed, parked and rejected —
each with its own colour on the card and on the matrix, so they never look equally important. Every
change of state is recorded with a reason, an author and a time, and nothing enters execution
without a person.

**The detail view** answers nine questions in order: what the opportunity is, why now, the
supporting signals grouped by where they came from, customer relevance (segment, need, unresolved
problem, why they might respond), competitive context (who addresses it, what is missing,
differentiation or expansion), brand fit as a checklist against the profile plus capabilities and
risks, potential impact by area — with no revenue figure, because nothing on file supports one —
the recommended next step, and the validation plan.

**Assessment is five separate dimensions**, never one mysterious score: potential impact,
feasibility, strategic fit and urgency are your team's judgement with the reasoning stored beside
each; evidence confidence is counted from the linked evidence by a stated rule. A composite is
offered only as a plain weighted mean, with its formula printed and the weights editable on the
left. An opportunity missing any assessment, or with no evidence linked, is marked **insufficiently
assessed** and is not scored or placed at all.

**The matrix** plots impact against feasibility on the same three-step scale the assessments use —
no finer scale is implied. Drag a disc into another cell and it changes that judgement; disc size is
urgency, outline colour is status, a dashed outline means thin or absent evidence.

**Validation experiments** carry hypothesis, target audience, the experiment, resources, timeframe,
success metric and the decision criteria — written before the result, which only a person ever
fills in.

**Handoff.** "Develop growth strategy" passes the opportunity, its market, its audience and its
success metric into the strategy builder, and stops there.

## Automatic brand research

Three inputs — name, website, category — and one button, **Analyse brand**. There is no long form.
NOETIS reads the brand's own pages, researches the category from outside sources, and comes back
with a brand intelligence report written for the founder: *Here's what we understood about X*.
Nothing it finds enters the profile until a person confirms it.

**The run** moves through eight stages that reflect real work: accessing the website, understanding
products and services, analysing the business model, researching the audience, analysing
positioning, exploring market context, reviewing public marketing presence, synthesising. A stage
that found nothing says so; a page that could not be read is listed as unread, not analysed. Five of
the stages come from a single analysis call and complete together, and the run log says so rather
than animating progress that is not happening.

**The report** opens with a summary of what the business does, sells, serves, solves and claims to
differentiate on, then eight chapters: business overview, product and value proposition, target
audience, brand positioning, market context, marketing presence, business and marketing objectives,
and an initial strategic assessment. Objectives are deliberately kept in three groups — what we
observed, what we inferred, and what we recommend validating with the founder — because public
research cannot see an internal target and should not pretend to.

**Everything is editable in place.** Select Edit on any finding, correct it, save. The correction is
filed as founder-confirmed and the original research is kept underneath it, visible on demand — an
edit is never a silent erasure. Add what the research missed at the end of any chapter, confirm a
chapter at a time or the whole profile at once, and leave sections unconfirmed if you want to.

**A later run cannot undo your decisions.** A confirmed finding is never overwritten; if new
research contradicts it, it arrives as a **proposed update** with Accept or Keep mine. Rejected
findings stay on file as rejected so the same claim is not proposed again as though it were new.

The engine is `api/research.js` in this repository, a serverless function. It cannot run in the
browser: a browser is not allowed to read another company's site, and an API key cannot live in a
page anyone can view.

**To turn it on**

1. Deploy this repository (the function deploys with it).
2. Set `ANTHROPIC_API_KEY` in the host's environment variables.
3. Reload the app. It asks `/api/research` whether it is configured and says so on screen; nothing
   is assumed either way.

| Variable | Required | What it does |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | yes | Lets the engine run. Without it the app shows the engine as not connected. |
| `RESEARCH_MODEL` | no | Model to use. Defaults to `claude-sonnet-4-5`. |
| `RESEARCH_WEB_SEARCH` | no | Set to `0` to read the brand's site only and skip external research. |

**What a run does**, in order: reads `robots.txt` and obeys it; reads the homepage and up to five
more pages (about, product, pricing, FAQ, contact) found by their links; takes what the brand says
about itself with the sentence it came from; researches the category externally with links and
dates; names competitors as candidates; files signals with their sources and limits. It stops
short of framing opportunities — those are framed by a person from this evidence.

**What it will not do**: invent a fact to fill a gap, state a market size, share or growth rate,
return a source it did not open, decide that a company is your competitor, or treat its own reading
as confirmed. An empty field is a correct answer and is shown as a gap.

Every record is written as it arrives, so a run that is cut short — a host timeout, a page that will
not load — still leaves everything it found up to that point, and says where it stopped. `vercel.json`
asks for a 300-second limit; your plan may cap it lower.

**A second run never undoes your decisions.** A claim you confirmed or rejected is left alone; a
candidate still waiting is refreshed in place rather than duplicated.

**Without the engine** the app says so plainly and falls back to the six-step onboarding, prefilled
with whatever you typed. It never fabricates a profile to fill the gap.

**One honest limitation:** the run streams into the browser tab that started it, so closing that tab
stops it. Everything found up to that point is already saved, and returning shows the report with a
notice that the run did not finish and an option to research again. A background job queue would fix
this properly and is not built.

## Running it

Open `index.html` in a browser. Data is saved in that browser's local storage, so it survives a
refresh but exists only on that device.

### Live deployment

`main` is connected to the Vercel project **noetis-intelligence-app**, so every push to `main`
deploys to production automatically:

<https://noetis-intelligence-app.vercel.app>

Vercel Authentication is on, so the URL asks for a sign-in to the Noetis Vercel team. Turn it off in
the project's Deployment Protection settings when the app is ready to show someone outside it.

### Other hosts

Any static host works:

- **GitHub Pages** — Settings → Pages → deploy from `main`, folder `/`.
- **Vercel** — import the repository; no framework preset or build command is needed.
- **Any web server** — copy `index.html` to the document root.

## The demo environment

The first screen offers a demo workspace: **AURELIA**, a fictional skincare brand, with six
fictional competitors, located market signals, opportunities, a strategy and illustrative Meta
campaign figures. It is labelled `DEMO` wherever it appears, every source ends in `.example` and
does not exist, and it can be reset or removed from Settings. Demo data is a separate brand record
and never writes into a real one.

## Configuration

The `CONFIG` block at the top of the script in `index.html`:

| Key | Purpose |
| --- | --- |
| `SUPABASE_URL` | Supabase project URL. With `SUPABASE_ANON_KEY` set, the app reads and writes there instead of the browser. |
| `SUPABASE_ANON_KEY` | The **publishable (anon)** key only. Never the service role key. |
| `RESEARCH_ENDPOINT` | A server function that streams discovery events as newline-delimited JSON. Not built yet. |
| `META_OAUTH_START_URL` | A server route that begins Meta OAuth. Not built yet. |
| `WORLD_SCRIPT` | Country outlines for the globe. Without it the globe falls back to a grid with country points and says so. |

Nothing secret belongs in this file: it is downloaded by everyone who opens the page. Service keys,
model provider keys and the Meta app secret stay on a server.

## Database

`schema.sql` creates the Postgres schema: workspaces and membership, brands, profile claims,
products, audiences, competitors, market signals, opportunities, opportunity evidence, strategies,
activity, and the integration tables. Run it once in the Supabase SQL editor.

Every tenant table carries `workspace_id` and is protected by Row Level Security, with roles for
owner, admin, strategist, analyst and client viewer. Access tokens live in `integration_secrets`,
which has RLS enabled and no policies, so only the server-side service role can read it.

**This schema has not yet been run against a live project.** Expect to fix something the first time.

## What works, and what does not

Working in the browser today:

- Guided onboarding in six steps, one question at a time, with autosave, skip, back, edit and resume.
- Competitive positioning and white-space maps: configurable dimensions, drag to reposition, territory analysis.
- The globe: rotation, zoom, region and country selection, signal filters, detail panels.
- Brand profile with provenance on every claim, and protection of user-confirmed answers.
- Opportunities: evidence linking, decisions with recorded reasons, manual priority, assignment, conversion to a strategy.
- Strategy builder and canvas, carrying brand and opportunity context forward.
- Activity log, data export, demo reset.

Simulated, and labelled as such in the interface:

- Everything about AURELIA, including its sources and global signals.
- The Meta figures and the Meta connect/disconnect control. No request is sent to Meta.

Working once the engine is deployed (`api/research.js`, needs `ANTHROPIC_API_KEY`):

- Reading the brand's own site, within robots.txt, and extracting what it says with the sentence it came from.
- Researching the category and market from outside sources, with links and dates.
- Proposing competitors as candidates and filing signals as evidence.
- The review screen where all of it is confirmed, edited or rejected before it joins the profile.

Not built — each needs more than this:

- Automatic generation of opportunities, messaging or recommendations.
- Meta OAuth, token storage and Ads Insights sync.
- Supabase sign-in, workspaces, roles and isolation between organisations (the schema is written; the app code is in place but untested against a live project).
- File storage for brand assets.

Credentials still required: a Supabase project URL and publishable key, `ANTHROPIC_API_KEY` for
the research engine, and a Meta app ID and secret with `ads_read` approved.

## Conventions this product keeps

- Evidence before confidence. Every claim is marked brand-stated, publicly observed, user-confirmed,
  AI-inferred or a hypothesis, and carries a source, a confidence level and a capture date.
- Nothing is invented. Where data is missing the interface says so rather than filling the space.
- No arbitrary scores. Impact, effort, urgency and fit are three-step judgements made by people;
  evidence strength follows a stated rule about how many signals are linked.
- A person makes every decision. Nothing is accepted, prioritised or published automatically.
