-- Earlier connections chose Gmail only. Discard incidental grants before enabling Calendar.
UPDATE accounts SET scopes = (
  SELECT json_group_array(value) FROM json_each(accounts.scopes)
  WHERE value IN (
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://mail.google.com/'
  )
);
