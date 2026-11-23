# ADR-0003: Validate the envelope before classifying decryption errors

Date: 2026-11-23
Status: Accepted

## Context

WebCrypto reports AES-GCM authentication failures as a generic `OperationError`. A stored token classified as damaged can force an account reconnect. A temporary local error or a configuration problem should leave the existing grant intact.

## Decision

Interpret a decryption `OperationError` as damaged ciphertext only after checking the envelope version, matching the key ID, and validating the nonce length and minimum ciphertext length for the authentication tag. Keep a key mismatch distinct. Treat other decryption errors as temporary unavailability.

## Consequences

The server can ask for a reconnect when stored ciphertext fails authentication under the expected key and format. An unavailable key or unsupported format keeps the grant available for recovery once the configuration or runtime works again.
