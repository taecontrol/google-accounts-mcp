# ADR-0011: Encrypt each stored file with its own key

Date: 2026-11-23
Status: Accepted

## Context

Uploaded files and downloaded attachments can contain private data. Workers KV can retain their encrypted bytes until expiration after the server clears the D1 data that refers to them.

## Decision

Generate an independent random encryption key for each file. Store the key only in sealed D1 references and store the ciphertext in KV. Use `TOKEN_KEY` to seal the reference without deriving file keys from it.

## Consequences

Deleting the last live reference removes the server's ability to decrypt the remaining KV bytes. KV can expire them on its own schedule. Reading a file requires both a sealed reference the server can open and the KV ciphertext.
