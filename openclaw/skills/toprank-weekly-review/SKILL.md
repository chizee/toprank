---
name: toprank-weekly-review
description: Run a weekly SEO review for one registered website, write audit artifacts, and choose the next best safe action.
metadata: { "openclaw": { "emoji": "📈", "homepage": "https://github.com/nowork-studio/toprank", "requires": { "bins": ["python3"] } } }
---

# Toprank Weekly Review

1. Read `{baseDir}/../../shared/adapter-rules.md`.
2. Read `{baseDir}/../../shared/artifact-contract.md`.
3. Read `{baseDir}/../../shared/policy.md`.
4. Resolve the target `site_id`; if no site was specified and multiple sites are active, run portfolio review first or ask the user which site to review.
5. Read and follow the canonical Toprank skill at `{baseDir}/../../../seo/seo-analysis/SKILL.md`.
6. Prefer the automated runner:
   - `python3 {baseDir}/../../bin/weekly_review.py <site_id-or-url>`
   - add `--gsc-property` if the site profile does not already contain one
   - add `--analysis-file` when testing against a saved GSC analysis JSON fixture
7. The runner will generate and persist the review artifacts automatically.
8. Verify that the run wrote `audit.json`, `action-plan.json`, and `verification.json`, refreshed `latest-state.json`, and created a follow-up queue item.
9. If the next action requires editing a site repo, CMS, publishing content, or opening a PR, stop and ask for approval before doing it.

## Wrapper job

Use this as the default weekly loop for a single site.

Your job:
- load the site profile, goals, and latest state,
- run a fresh review using the canonical SEO analysis skill,
- identify the top three issues,
- prioritize exactly one next best action,
- write `audit.json`, `action-plan.json`, and `verification.json`.

When possible, also create a queue item for a 14-day or 28-day follow-up check.
