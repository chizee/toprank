# Artifact Contract

The OpenClaw adaptive layer is artifact-first. Runs should leave behind structured JSON that another agent turn can resume from.

## Portfolio files

- `portfolio.json` — registry of sites, business weights, cadence, and status
- `schedule.json` — future recurring checks and follow-up tasks

## Per-site files

- `site-profile.json` — stable description of the website
- `goals.json` — active and archived SEO goals
- `latest-state.json` — compact snapshot used for fast re-entry
- `learned-patterns.json` — site-local lessons with confidence

## Per-run files

Each run lives under:

```text
sites/<site_id>/runs/<timestamp>/
```

Recommended files:

- `trigger.json`
- `state-snapshot.json`
- `audit.json`
- `action-plan.json`
- `proposal.json`
- `patch-set.json`
- `verification.json`
- `feedback.json`
- `learning-log.json`

## Minimal required shape

### audit.json
Must answer:
- what problem was found?
- what evidence supports it?
- how severe is it?

### action-plan.json
Must answer:
- what should happen next?
- what is the expected impact?
- does it require approval?

### verification.json
Must answer:
- what was checked?
- what is safe/unsafe?
- what follow-up is required?

## Queue items

Queue files under `sites/<site_id>/queue/` represent deferred work. Typical items:

- weekly review
- feedback check in 14 days
- page improvement pending approval
- revisit indexing issue after deploy
