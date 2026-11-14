-- Results belong to each creating tool. once stores only IDs, links, and outcome flags.
CREATE TABLE once_new (
  identity TEXT PRIMARY KEY NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'done', 'unknown')),
  claim TEXT NOT NULL,
  request_key TEXT NOT NULL,
  taken_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  result TEXT CHECK (result IS NULL OR json_valid(result)),
  CHECK ((state = 'done') = (result IS NOT NULL))
) STRICT;
INSERT INTO once_new (identity, state, claim, request_key, taken_at, expires_at, result)
SELECT identity, state, claim, lower(hex(randomblob(16))), taken_at, expires_at,
  CASE WHEN state = 'done' THEN
    CASE WHEN draft_id IS NULL THEN json_object('message', message_id, 'thread', thread_id)
      ELSE json_object('draft', draft_id, 'message', message_id, 'thread', thread_id) END
    ELSE NULL END
FROM once;
DROP TABLE once;
ALTER TABLE once_new RENAME TO once;
CREATE INDEX once_expiry ON once(expires_at);
