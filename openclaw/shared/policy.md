# Policy

## Default operating mode

Use **operator mode** by default:

- generate drafts and proposals automatically,
- ask before any external or production write.

## Safety classes

### Auto-safe
- local audits
- artifact writes
- queue updates
- proposal generation
- internal prioritization

### Approval-required
- repo file edits for the target website
- CMS writes
- PR creation
- content publication
- production metadata changes

### Blocked from auto
- destructive mass changes
- irreversible public actions
- bulk redirects without review

## Business weighting

Use the `business_weight` in `portfolio.json` when ranking sites. Important sites should receive more attention, but active regressions may still preempt lower-value growth work.
