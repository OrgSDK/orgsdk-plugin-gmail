# Changelog

## 1.0.7 (unreleased)

- Pin the authoring/execution packages to 0.2.2/0.1.0, with the tracked executor packaging fixes.
- Build a restricted npm distribution and verify every exported function from the packed artifact through the headless executor.
- Add versioned npm release CI that publishes the exact tested tarball after explicit repository activation.

All notable releases of `@orgsdk/plugin-gmail` are documented here.

The catalog treats versions as **write-once**: a given `(slug, version)` may be
re-published only with identical artifact content; differing content is
rejected with HTTP 409. Every entry below is therefore forward-only.

## [1.0.6] — Google BYO OAuth setup guide

### Added
- **`auth.setupGuide`** — a complete structured setup guide that the dashboard
  renders as an in-product checklist for bringing your own Google OAuth client.
  Gmail requires BYO (restricted `https://mail.google.com/` scope; no one-click
  connect), so the guide is the primary connection path.
  - Seven ordered steps: Google Cloud project → enable the Gmail API → consent
    screen → Web application OAuth client → authorized redirect URI → download
    JSON → connect.
  - Callback URL presentation (`{ label, instruction }`), credential field
    presentation (`{ label, description, placeholder }`), prerequisites, and an
    HTTPS troubleshooting URL.
  - Permission presentation for `https://mail.google.com/` with a readable
    label and the `Restricted / broad` classification.
  - Every external link is HTTPS-validated by the canonical author schema.

### Changed
- Bump `plugin/.plugin.json` version `1.0.5` → `1.0.6`.
- Bump `package.json` version `1.0.5` → `1.0.6`.
- Bump `@orgsdk/plugins` devDependency `0.2.1` → `0.2.2` (models
  `auth.setupGuide`). **The lockfile must be regenerated after SDK 0.2.2 is
  published to npm** — see `docs/release.md`.
- `tests/manifest.test.ts` version assertion → `1.0.6` and new setup-guide
  assertions.

### Frozen (unchanged from 1.0.5)
- All thirteen safe functions, the BYO authProvider, GET /callback, the
  restricted scope, the first-party rejection, and runtime dependencies.

## [1.0.5] — provenance + static-action-scanner correction (forward-only)

A forward-only patch release that re-establishes this standalone repository as
the **canonical source** of the `gmail` plugin. **No plugin source behavior
changed** — the thirteen safe functions, the `google-oauth` BYO connect contract
(authProvider + GET /callback), the restricted `https://mail.google.com/` scope,
the explicit first-party rejection, the 3-tier BYO resolution, and the
`@googleapis/gmail` + `google-auth-library` + `turndown` runtime dependencies
are byte-identical to `1.0.2` (the last release from this repository).

### Why 1.0.5 (and what happened to 1.0.3 / 1.0.4)

After the Phase 3 static-action-scanner fix landed in the monorepo
(`7baf93c` — regex/template-aware field extraction; `d9f4cfb` — send
pre-resolution source so the server can derive actions), `gmail` was
**mistakenly re-published through the monorepo `scripts/publish-plugin.ts`
path** rather than from this external repository. That produced catalog entries
`1.0.3` and `1.0.4` from **stale monorepo bytes**, with two regressions:

1. **Lost provenance.** The monorepo source does not carry
   `marketplace.links.sourceRepo`; only this repository's manifest does. Both
   `1.0.3` and `1.0.4` therefore shipped with **no source-repository link**,
   breaking the canonical-source guarantee for an external plugin.
2. **Misclassified safety metadata.** Under the pre-fix scanner those entries
   derived **all thirteen** functions as `write` — the five read operations lost
   their `readonly` tags entirely (no `readonly`, no `discovery`).

Because catalog versions are write-once, `1.0.3` and `1.0.4` are immutable
history and **cannot be repaired in place** (any differing re-publish is
rejected with HTTP 409). They are documented here as a non-functional detour and
**superseded** by `1.0.5`. The external-repository HEAD never moved past the
`1.0.2` extraction commit (`7f38fde`); `1.0.5` is the first forward release from
this repository since then.

### Corrected by 1.0.5

- **Provenance restored.** The manifest's `marketplace.links.sourceRepo` again
  points at `https://github.com/OrgSDK/orgsdk-plugin-gmail`, so the catalog
  latest reflects the canonical external source.
- **Safety metadata corrected.** With the now-deployed scanner fix
  (template-aware `metadata` extraction over **pre-resolution** source), the
  thirteen functions derive correctly: **five `readonly`** read operations
  (`getMessages`, `getMessage`, `getThread`, `listLabels`, `getMessageAttachment`)
  and **eight `write`** operations (three label ops, two read-state ops, and the
  three sends — `sendMessage`, `sendMessageWithAttachment`, `replyToMessage`).
  The source already carried `readonly: true` / `discovery: true` on the read
  functions; only the derivation was broken before.

### Changed

- Bump `plugin/.plugin.json` version `1.0.2` → `1.0.5` (catalog source of
  truth).
- Bump `package.json` version `1.0.2` → `1.0.5` (kept in sync; enforced by the
  CI version guard).
- `tests/manifest.test.ts` version assertion → `1.0.5`.
- `docs/release.md` current-version pointer + this release section.

### Frozen (unchanged from 1.0.2)

- All thirteen safe functions — names, parameters, return types, metadata, tags,
  the readonly/write split (five readonly, eight write), and the five discovery
  flags.
- The `google-oauth` connect-ownership contract, the restricted scope, the
  explicit first-party rejection, and the 3-tier BYO resolution.
- Every TypeScript source file under `plugin/` (`gmail-functions.ts`,
  `auth-provider.ts`, `oauth.ts`, `terminal-oauth-flow.ts`, `index.ts`) and the
  plugin docs/guides — byte-identical to `1.0.2`.
- Runtime dependencies and the deterministic bundling closure.

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
