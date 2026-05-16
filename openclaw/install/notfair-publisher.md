# NotFair Publisher — Webhook Contract

`openclaw/bin/publish_pending.py` POSTs ready blog posts from a Toprank content
calendar to a NotFair-hosted Next.js webhook. This file is the contract: the
Next.js handler on `notfair.co` must accept exactly this shape.

If you change either side, update this file in the same commit. Keep the
publisher and the handler in lockstep.

---

## Endpoint

```
POST https://notfair.co/api/blog/publish
```

Configurable via `NOTFAIR_PUBLISH_URL`. For local Next.js dev, point at
`http://localhost:3000/api/blog/publish`.

## Auth

```
Authorization: Bearer <NOTFAIR_PUBLISH_TOKEN>
```

The token is a long-lived secret the user provisions in the NotFair admin and
exports as `NOTFAIR_PUBLISH_TOKEN` in their OpenClaw cron environment. The
handler MUST reject requests without a valid Bearer token (401).

There is no HMAC signing in v1. If you need request integrity, add an
`X-NotFair-Signature` header in a future version and bump `schemaVersion`.

## Request body

`Content-Type: application/json`

```json
{
  "schemaVersion": "1",
  "slug": "facebook-seo-optimization",
  "title": "Facebook SEO Optimization: 7 Tactics That Actually Move Pipeline",
  "primaryKeyword": "facebook seo optimization",
  "secondaryKeywords": ["facebook page seo", "facebook search ranking"],
  "intent": "informational",
  "type": "blog",
  "metaDescription": "...",
  "body": "# ...\n\nMarkdown body of the post.",
  "bodyFormat": "markdown",
  "featuredImage": {
    "url": "https://cdn.notfair.co/blog/facebook-seo/featured.webp",
    "alt": "...",
    "width": 1200,
    "height": 1200
  },
  "inlineImages": [
    { "url": "...", "alt": "...", "placement": "after-h2-1" }
  ],
  "structuredData": { "@context": "https://schema.org", "@type": "BlogPosting", "...": "..." },
  "scheduledAt": "2026-05-22",
  "source": { "tool": "toprank", "skill": "content-planner", "version": "1" }
}
```

**Field notes:**

- `slug` (required) — used as the URL slug. Must be stable; re-publishing the
  same slug is treated as an update by the Next.js side.
- `body` (required) — Markdown. The Next.js handler is responsible for
  rendering to HTML, sanitization, and CMS persistence.
- `bodyFormat` — currently always `"markdown"`. Reserved for future `"html"`
  or `"mdx"` values.
- `featuredImage` — may be `null` if the planner couldn't generate one;
  handler should reject with 400 if your site requires it.
- `inlineImages` — array; `placement` is an opaque hint ("after-h2-1",
  "after-h2-2", etc.) the handler can use to position images.
- `structuredData` — JSON-LD object; handler should embed verbatim in `<head>`.

## Response — 2xx (success)

```json
{
  "ok": true,
  "url": "https://notfair.co/blog/facebook-seo-optimization",
  "publishedAt": "2026-05-22T14:30:00Z"
}
```

The publisher reads `url` (or `publishedUrl`) and stores it on the calendar
entry as `publishedUrl`. The full response body is stored under
`entry.response` for audit.

## Response — 4xx (non-retryable failure)

```json
{
  "ok": false,
  "error": "invalid slug",
  "code": "slug_collision"
}
```

The publisher marks the calendar entry as `status: "failed"` and stores the
response body in `entry.lastError`. The cron will **not** retry. The user must
fix the entry (rename slug, add missing fields, etc.) and flip status back to
`ready_to_publish` to try again.

Common 4xx cases the handler should map:
- `400` — schema validation failure (missing required field, bad format)
- `401` — missing or invalid Bearer token
- `409` — slug collision with an existing post
- `413` — body too large

## Response — 5xx (retryable failure)

The publisher leaves the entry as `ready_to_publish` and stores the response
body in `entry.lastError`. The cron will retry on its next pass.

The handler should return 5xx **only for transient failures** — DB unavailable,
upstream timeout, etc. Return 4xx for permanent errors so the publisher stops
hammering.

## Idempotency

The handler MUST tolerate the same `slug` being submitted more than once:

- If the previous publish succeeded and the cron retries (e.g. response was
  lost mid-flight), the handler returns 2xx with the same `url`.
- If the body has changed, treat as an update — overwrite the existing post.

The publisher does not currently send an idempotency key; rely on `slug`.

## Rate

The cron runs at the interval configured via `--scheduler-every` (default 1h
for the OpenClaw scheduler; the publisher job defaults to every 15 min — see
`install-openclaw-cron.sh --enable-publisher`). A single run POSTs once per
ready entry, sequentially, with no concurrency. No backoff between requests.

## Versioning

Bump `schemaVersion` when adding required fields or changing semantics. The
handler should accept `schemaVersion: "1"` for the foreseeable future; minor
field additions are backward-compatible. Drop support only after every
deployed publisher has rolled forward.
