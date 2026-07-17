# Changelog

All notable releases of `@orgsdk/plugin-gmail` are documented here.

The catalog treats versions as **write-once**: a given `(slug, version)` may be
re-published only with identical artifact content; differing content is
rejected with HTTP 409. Every entry below is therefore forward-only.

## [1.0.2] — standalone repository extraction

A forward-only patch release that migrates the `gmail` plugin from the
OrgSDK monorepo (`packages/plugins/src/gmail/`) into this standalone
repository. **No plugin source behavior changed** — the thirteen safe functions,
the `google-oauth` BYO connect-ownership contract (authProvider + GET /callback),
the restricted `https://mail.google.com/` scope, the explicit first-party
rejection, the 3-tier BYO resolution (no first-party fallback), and the
`@googleapis/gmail` + `google-auth-library` + `turndown` runtime dependencies
are byte-identical to the monorepo `1.0.1`.

### Why 1.0.2 (not 1.0.1)

The repository/package/schema additions alter the immutable publishable content
of the staged artifact:

- manifest `$schema` (`https://orgsdk.ai/schemas/plugin-manifest.v1.json`)
- `marketplace.links.sourceRepo` provenance link
- type-only import specifiers (`orgsdk/plugins` → `@orgsdk/plugins`)
- the generated artifact `package.json` carrying the runtime dependencies

Because catalog versions are write-once, the existing `1.0.1` artifact cannot be
re-published with this changed content — it would differ and be rejected with
HTTP 409. Rather than mutate the published history of `1.0.1`, the new artifact
lands as a fresh `1.0.2` entry.

### Changed

- Bump `plugin/.plugin.json` version `1.0.1` → `1.0.2` (catalog source of
  truth).
- Bump `package.json` version `1.0.1` → `1.0.2` (kept in sync; enforced by the
  CI version guard).
- Add manifest `$schema` and `marketplace.links.sourceRepo`.
- Update type-only import specifiers `orgsdk/plugins` → `@orgsdk/plugins`.
- **Install-resolution correction (zero runtime change).** A repo-local
  `overrides` entry dedupes `google-auth-library` to a single copy for local
  typechecking. See
  [docs/contract-migration.md](docs/contract-migration.md#install-resolution-correction-zero-runtime-change).

### Frozen (unchanged from monorepo 1.0.1)

- All thirteen safe functions — names, parameters, return types, metadata, tags,
  the readonly/write split (five readonly, eight write), and the five discovery
  flags.
- The `google-oauth` connect-ownership contract: **authProvider present**
  (`GmailOAuthProvider`), `requiredCredentials: ["google-oauth"]` on every
  function, the GET /callback httpEndpoint, the restricted scope
  `https://mail.google.com/`, and the callbackPath `/callback`. Gmail owns its
  own BYO callback (the shared connect owner for the union scopes is
  google-sheets).
- The **explicit first-party rejection** in `oauth.ts` (`getGoogleOAuth2Client`
  throws when `source === "first-party"`).
- The 3-tier BYO resolution order (`google-oauth-client/default` →
  `google-oauth-client/<name>` → `google-oauth/<name>` client fields) with
  **no** first-party relay fallback (`resolveByoClient` returns `null`).
- No `config` (no Zod tenant_config schema), no `tables`, no
  `isFirstPartyAvailable` (BYO only).
- The factory `PluginModule` entry shape (`default export` →
  `(ctx) => PluginModule`).
- The `@googleapis/gmail` (`^17.0.0`), `google-auth-library` (`^10.6.2`), and
  `turndown` (`^7.2.4`) runtime dependencies and their usage.
- `plugin/docs/overview.md` and `plugin/guides/usage-patterns.md` — verbatim.

### Dependency-closure determination

`@googleapis/gmail@^17.0.0` resolves to `17.0.0`. Its direct dependency is
`googleapis-common@^8.0.0`, which pins `google-auth-library@10.5.0` exactly.
`google-auth-library@^10.6.2` (declared at top level) resolves to `10.9.0`.
`turndown@^7.2.4` is a direct runtime import (HTML email bodies → markdown);
it is a pure-JS library that constructs and runs under Bun with no DOM addon.

`Bun.build` (target: `bun`, format: `esm`) inlines the full closure (the two
Google packages, turndown, and their transitives) into a single deterministic
`__bundle.js`. The daemon imports it directly — no `node_modules`, no native
binary. `tests/google-bundle.test.ts` verifies this end to end: the bundle
loads, the factory materializes all thirteen safe functions, the authProvider
and GET /callback endpoint are present — all without a network call.

### Server-process assumptions

- **Publish time:** `resolvePluginDeps` runs `bun install` + `Bun.build` in a
  temp staging dir. Requires network access to resolve the Google packages and
  turndown from npm. Produces a deterministic `__bundle.js` (pure JS).
- **Daemon runtime:** imports `__bundle.js` directly. No `node_modules`, no
  native binary. Works in the standard daemon container image. Makes outbound
  HTTPS to `www.googleapis.com` at call time (gated by the connected
  credential's scopes). **No relay calls** — BYO credentials refresh locally
  using the bundled client secret.
