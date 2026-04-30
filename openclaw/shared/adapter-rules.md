# Adapter Rules

These rules apply to every `openclaw/skills/*` wrapper.

## 1. Preserve the canonical skills

The existing Toprank skills under `seo/` and `google-ads/` remain the source of truth for domain expertise. Do not fork or silently rewrite them inside the OpenClaw surface.

## 2. Treat OpenClaw as the operator layer

The wrapper is responsible for:

- selecting the right site,
- loading persistent state,
- deciding whether to run at the portfolio or site level,
- writing structured artifacts,
- applying policy gates,
- scheduling follow-up work.

## 3. Runtime home

Use:

```bash
TOPRANK_OPENCLAW_HOME="${TOPRANK_OPENCLAW_HOME:-$HOME/.toprank/openclaw}"
```

Never write live operator state into this git repo.

## 4. Site selection

Every wrapper must resolve a `site_id` before acting. Use the helper:

```bash
python3 {baseDir}/../../bin/site_id.py https://example.com
```

If the user did not specify a site and multiple sites are active, either:

- run `toprank-portfolio-review`, or
- ask the user which site they mean.

## 5. Required artifacts

Every non-trivial run should write at least:

- `audit.json`
- `action-plan.json`
- `verification.json`

under:

```text
$TOPRANK_OPENCLAW_HOME/sites/<site_id>/runs/<timestamp>/
```

## 6. Approval boundaries

Wrappers may automatically:

- read site state,
- run analysis,
- update queue items,
- generate proposals and drafts.

Wrappers must ask first before:

- editing website repo files,
- writing to a CMS,
- opening a PR,
- publishing or deploying changes.

## 7. Multi-site first

Assume the operator owns multiple websites. State must stay isolated by site. Never mix artifacts from two sites in the same run folder.

## 8. Feedback discipline

If a wrapper proposes or drafts an action, it should also write a queue or schedule entry for a future outcome check when the action is time-based.
