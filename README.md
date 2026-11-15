# NOETIS Intelligence

A brand and growth intelligence workspace: understand the competitive landscape, understand the
brand, identify the opportunity, develop the strategy.

The whole application is one self-contained file, [`index.html`](index.html). It has no build step
and no dependencies to install. Open it in a browser, or host it anywhere that serves a static file.

## The four modules

| Module | What it answers |
| --- | --- |
| **Competitive Intelligence** | Where does the brand stand? Positioning map, competitor directory and profiles, white-space analysis, global signal globe, category trends, competitive movement. |
| **Brand & Market Intelligence** | What do we actually know, and how do we know it? Nine chapters, every claim carrying its source, confidence and verification status. |
| **Opportunity Signals** | Where could the brand move next? Brand position, market and competitive change, underserved needs, opportunities with linked evidence, an impact-against-feasibility matrix. |
| **Growth Strategy** | How do we act on it? A strategy builder that starts from an accepted opportunity, a twelve-part strategy canvas, and a Meta workspace. |

Every screen uses the same architecture: global navigation on the far left, the module's controls
and filters beside it, and the intelligence canvas on the right.

## Running it

Open `index.html` in a browser. Data is saved in that browser's local storage, so it survives a
refresh but exists only on that device.

To put it online, any static host works:

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

- Guided onboarding in five groups, one question at a time, with autosave, skip, back, edit and resume.
- Competitive positioning and white-space maps: configurable dimensions, drag to reposition, territory analysis.
- The globe: rotation, zoom, region and country selection, signal filters, detail panels.
- Brand profile with provenance on every claim, and protection of user-confirmed answers.
- Opportunities: evidence linking, decisions with recorded reasons, manual priority, assignment, conversion to a strategy.
- Strategy builder and canvas, carrying brand and opportunity context forward.
- Activity log, data export, demo reset.

Simulated, and labelled as such in the interface:

- Everything about AURELIA, including its sources and global signals.
- The Meta figures and the Meta connect/disconnect control. No request is sent to Meta.

Not built — each needs a server:

- Website reading and AI extraction; competitor, market and global signal research.
- Automatic generation of opportunities, messaging or recommendations.
- Meta OAuth, token storage and Ads Insights sync.
- Supabase sign-in, workspaces, roles and isolation between organisations (the schema is written; the app code is in place but untested against a live project).
- File storage for brand assets.

Credentials still required: a Supabase project URL and publishable key, a model provider API key
(server-side), a search or crawling provider, and a Meta app ID and secret with `ads_read` approved.

## Conventions this product keeps

- Evidence before confidence. Every claim is marked brand-stated, publicly observed, user-confirmed,
  AI-inferred or a hypothesis, and carries a source, a confidence level and a capture date.
- Nothing is invented. Where data is missing the interface says so rather than filling the space.
- No arbitrary scores. Impact, effort, urgency and fit are three-step judgements made by people;
  evidence strength follows a stated rule about how many signals are linked.
- A person makes every decision. Nothing is accepted, prioritised or published automatically.
