# SEP-1: `stellar.toml` Discovery

`fetchStellarToml` (`src/integration/sep1Toml.ts`) resolves a domain's SEP-1
`stellar.toml` document for federation, SEP-10 web auth, SEP-6/SEP-24
transfer server discovery, and asset metadata.

## Path resolution order

1. **`https://<domain>/.well-known/stellar.toml`** — the only path defined
   by the [SEP-1 spec](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0001.md).
   This is always tried first and is the path every compliant anchor,
   issuer, or wallet backend is expected to serve.
2. **`https://<domain>/stellar.toml`** (legacy root fallback) — tried only
   when the `.well-known` request fails (404, network error, or invalid
   TOML). Some domains that implemented `stellar.toml` discovery before
   SEP-1 standardized the `.well-known` path still only serve it at the
   root. Falling back here lets those domains still be discovered instead
   of failing outright, while never preferring the legacy path over the
   compliant one when both exist.

The domain is otherwise validated the same way for either path: HTTPS only,
no userinfo, no query string or fragment on the input domain itself.

## Caching and revalidation

Successful lookups (at either path) are cached per-origin for `ttlMs`
(default 5 minutes). By default, a cache hit is revalidated against a fresh
`.well-known` fetch before being trusted; if the fresh document disagrees
with the cached one on `SIGNING_KEY` or any `CURRENCIES` issuer, the cache
is invalidated and the fresh document is returned instead (see
`detectStellarTomlConflict`). Revalidation always starts from
`.well-known` again, not from whichever path satisfied the original
lookup — a domain that migrates from the legacy root path to `.well-known`
is picked up automatically on the next revalidation.
