-- Chat-thread management for the thread rail: user-set display titles
-- (rename), and pinning. `title` overrides the derived first-message
-- preview when set; `pinned_at` doubles as the pin flag and the
-- pin-order tiebreaker (most recently pinned first). Delete needs no
-- schema: transcript_events already cascades on session delete.

ALTER TABLE sessions ADD COLUMN title     TEXT;
ALTER TABLE sessions ADD COLUMN pinned_at TEXT;
