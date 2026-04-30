# OpenClaw Adaptive Layer (MVP)

Toprank's OpenClaw surface is a thin adaptive layer that sits on top of the existing open-source SEO skills. It does **not** replace `seo/` or `google-ads/`. It adds multi-site state, scheduled review loops, artifact writing, and policy gates so an operator can manage a portfolio of websites from one OpenClaw workspace.

## Product definition

**Goal:** maximize qualified organic growth across a portfolio of websites, subject to explicit safety and approval rules.

**Core idea:** the existing Toprank skills are capability modules; the OpenClaw layer is the operator.

## Operating model

The layer runs two loops:

1. **Portfolio loop** — look across all registered sites, rank urgency and opportunity, decide where attention should go next.
2. **Site loop** — observe a single site, diagnose the highest-leverage issue, propose or draft the next action, verify it, and schedule a later feedback check.

## MVP scope

The MVP deliberately stays narrow.

### Supported actions
- title/meta rewrite proposals
- schema proposals
- internal-link recommendations
- page improvement proposals
- traffic-drop investigation plans
- weekly review prioritization

### Not in MVP
- automatic publishing to CMS
- autonomous mass rewrites
- automatic redirect sweeps
- cross-site learned priors driving writes without approval

## Multi-site workspace layout

Runtime state lives **outside the repo** under `~/.toprank/openclaw` by default.

```text
~/.toprank/openclaw/
├── portfolio.json
├── schedule.json
└── sites/
    ├── example.com/
    │   ├── site-profile.json
    │   ├── goals.json
    │   ├── latest-state.json
    │   ├── learned-patterns.json
    │   ├── queue/
    │   ├── proposals/
    │   ├── runs/
    │   └── feedback/
    └── example-service.com/
        └── ...
```

The repo contains the shared layer under `openclaw/`:

```text
openclaw/
├── README.md
├── artifacts/
│   ├── examples/
│   └── schemas/
├── bin/
├── install/
├── shared/
└── skills/
```

## JSON file catalog

### Portfolio-level

- `portfolio.json` — the registry of all sites, their business weight, cadence, and status.
- `schedule.json` — upcoming recurring checks and feedback follow-ups.

### Per-site core files

- `site-profile.json` — domain, canonical URL, brand terms, CMS, primary business context.
- `goals.json` — one or more active SEO goals for the site.
- `latest-state.json` — the last summarized state snapshot used for quick loading.
- `learned-patterns.json` — site-local observations about what interventions have worked or failed.

### Per-site work folders

- `queue/` — pending work items the layer should revisit.
- `proposals/` — generated proposals and patch candidates waiting for review or approval.
- `runs/` — immutable run artifacts grouped by timestamp.
- `feedback/` — post-action outcome reviews.

### Per-run files

Each run directory under `sites/<site_id>/runs/<timestamp>/` can contain:

- `trigger.json`
- `state-snapshot.json`
- `audit.json`
- `action-plan.json`
- `proposal.json`
- `patch-set.json`
- `verification.json`
- `feedback.json`
- `learning-log.json`

The MVP requires at least:
- `audit.json`
- `action-plan.json`
- `verification.json`

## Policy model

### Auto-safe
- run audits
- write local artifacts
- update queue items
- generate proposals and drafts

### Approval-required
- edit website repo files
- write to a CMS
- open a PR
- publish content or metadata

### Blocked from auto
- delete content in production
- deploy bulk redirect changes
- perform irreversible public changes without approval

## Wrapper skills

The MVP ships five OpenClaw-facing wrapper skills:

- `toprank-site-onboard`
- `toprank-portfolio-review`
- `toprank-weekly-review`
- `toprank-improve-page`
- `toprank-investigate-drop`

These wrappers keep the existing `seo/` skills as the source of truth. The wrapper adds:

- site selection
- multi-site state loading
- artifact writing
- policy gating
- follow-up scheduling

## Recommended cadence

- **daily** — lightweight portfolio health scan
- **weekly** — portfolio review + top site deep review
- **14/28 day** — feedback checks on prior actions

## Success criteria for MVP

The MVP is working if an OpenClaw operator can:

1. register multiple websites,
2. keep a separate work folder for each site,
3. run a portfolio review to decide where to focus,
4. run a site review that produces structured artifacts,
5. draft one safe next action,
6. schedule and record a follow-up result.

## Working implementation status

The current MVP includes these concrete helper flows:

- `openclaw/bin/onboard_site.py` — creates or updates the site work folder, portfolio entry, and initial goal.
- `openclaw/bin/weekly_review.py` — runs or reads Search Console analysis, builds the weekly review payload automatically, persists the run, and seeds baseline metrics for follow-up scoring.
- `openclaw/bin/persist_run.py` — takes a structured review payload and writes a timestamped run with `audit.json`, `action-plan.json`, `verification.json`, and optional queue items.
- `openclaw/bin/portfolio_review.py` — ranks active sites using business weight, open issues, and active goals, then writes a portfolio review snapshot.
- `openclaw/bin/improve_page.py` — persists a page-improvement proposal, optional patch-set, and feedback follow-up.
- `openclaw/bin/investigate_drop.py` — persists a traffic-drop investigation, ranked recovery actions, and optional page-improvement follow-up.
- `openclaw/bin/followups_due.py` — lists scheduled follow-up items that are due, making the schedule actionable.
- `openclaw/bin/run_scheduler.py` — processes due schedule entries, auto-materializes feedback-check runs, and surfaces manual-attention items.
- `openclaw/bin/record_followup_metrics.py` and `openclaw/bin/score_feedback.py` — let the operator attach observed metrics to a follow-up and score it as a win / neutral / loss / inconclusive.
- `openclaw/bin/hydrate_followup_gsc.py` — can populate observed metrics from real Google Search Console data when a site has a GSC property or canonical URL configured.

This means the adaptive layer can already persist real onboarding, automated weekly-review state, page-improvement proposals, drop investigations, due follow-up discovery, simple autonomous schedule processing, first-pass feedback scoring, and site-local learned priors even before the higher-level wrappers become fully autonomous.

## Priority adaptation

The weekly review runner now reads `learned-patterns.json` before ranking actions.

That means the same site can evolve different preferences over time:
- if `meta_tags` repeatedly improves `non_brand_clicks_28d`, weekly review boosts it,
- if `page_improvement` repeatedly loses on the same metric, weekly review discounts it,
- if no prior exists, the runner falls back to raw severity and opportunity heuristics.

This is the first real behavior change driven by past outcomes.
