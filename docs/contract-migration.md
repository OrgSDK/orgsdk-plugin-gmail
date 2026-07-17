# Contract migration — completed

## Status: consuming `@orgsdk/plugins` from npm

This plugin imports its authoring types from the public
[`@orgsdk/plugins`](https://www.npmjs.com/package/@orgsdk/plugins) npm package.
The migration from the monorepo workspace specifier is complete.

## What changed (from the monorepo source)

1. **Import specifiers updated** — `from "orgsdk/plugins"` →
   `from "@orgsdk/plugins"`. All imports are **type-only**
   (`import type { … }`), erased at compile time.
2. **devDependency** is the published npm package, pinned to an exact version
   (`@orgsdk/plugins@0.2.1`) for reproducibility.
3. **Purity guards** — type-only imports from `@orgsdk/plugins` are
   allowed; value imports and all other `@orgsdk/*` packages are blocked
   (enforced by `tests/purity.test.ts` and `orgsdk-plugin validate`).
4. **Artifact runtime dependencies — `@googleapis/gmail` + `google-auth-library` + `turndown`.**
   `gmail-functions.ts` imports `{ gmail_v1 }` from `@googleapis/gmail` at
   runtime and constructs a `gmail_v1.Gmail` client; `auth-provider.ts`,
   `oauth.ts`, and `terminal-oauth-flow.ts` import `{ OAuth2Client }` from
   `google-auth-library` and build the OAuth2 client from the shared
   `google-oauth` bundle; `gmail-functions.ts` imports `TurndownService` from
   `turndown` and converts HTML email bodies to markdown. All three are declared
   as runtime `dependencies` entries, so the generated artifact `package.json`
   carries `"dependencies": { "@googleapis/gmail": "^17.0.0", "google-auth-library": "^10.6.2", "turndown": "^7.2.4" }`
   and the platform's `resolvePluginDeps` bundles the full closure into
   `__bundle.js` at publish time. The daemon imports the bundle directly — no
   runtime node_modules resolution. The authoring SDK (`@orgsdk/plugins`) is
   **not** a runtime dependency (type-only imports are erased at compile time).
5. **Manifest `$schema`** — `plugin/.plugin.json` declares
   `$schema: https://orgsdk.ai/schemas/plugin-manifest.v1.json` for editor
   completion and schema validation.
6. **Provenance** — `marketplace.links.sourceRepo` points at this repository
   (canonical key supported by `plugin-manifest.v1`). The upstream Gmail APIs
   are documented in the README; the `homepage` (mail.google.com) and `docs`
   (developers.google.com/gmail/api) user-facing links are preserved verbatim.
7. **No local management scripts** — `validate`, `package`, `version-guard`,
   and `publish` are npm scripts that delegate to the `orgsdk-plugin` CLI
   shipped by `@orgsdk/plugins`.
8. **Reusable CI/CD workflows** — `.github/workflows/ci.yml` and
   `publish-catalog.yml` call the centrally maintained reusable workflows in
   `OrgSDK/plugins` (pinned to an immutable commit) instead of duplicating
   CI/publish mechanics.

## What did NOT change (frozen behavior)

- All thirteen safe functions — names, parameters, return types, metadata, tags,
  the readonly/write split (five readonly, eight write), and the five discovery
  flags.
- The `google-oauth` **connect-ownership** contract: `authProvider` present
  (`GmailOAuthProvider`), `requiredCredentials: ["google-oauth"]` on every
  function, the GET /callback httpEndpoint, the restricted scope
  `https://mail.google.com/`, and `callbackPath: "/callback"`. Gmail owns its
  own BYO callback.
- The **explicit first-party rejection** — `getGoogleOAuth2Client` throws when
  `source === "first-party"` because a restricted scope cannot be satisfied by
  the relay-held first-party client.
- The 3-tier BYO resolution order in `auth-provider.ts` (`resolveByoClient`):
  `google-oauth-client/default` → `google-oauth-client/<name>` →
  `google-oauth/<name>` client fields, with **no** first-party relay fallback
  (returns `null` when no client is configured).
- BYO local-refresh semantics in `oauth.ts` — BYO bundles refresh locally using
  the bundled `client_secret`; the refresh happens lazily on the first
  authenticated API request.
- No `config` (no Zod tenant_config schema), no `httpEndpoints` beyond the
  /callback, no `tables`, no `isFirstPartyAvailable`.
- The factory `PluginModule` entry shape (`default export` →
  `(ctx) => PluginModule`) — not a static `safeFunctions` export.
- The `@googleapis/gmail`, `google-auth-library`, and `turndown` usage —
  byte-identical.
- `plugin/docs/overview.md` and `plugin/guides/usage-patterns.md` — verbatim.

## Install-resolution correction (zero runtime change)

`googleapis-common@^8.0.0` (a direct dependency of `@googleapis/gmail@17.0.0`)
pins `google-auth-library` to an **exact** `10.5.0`, while this plugin declares
`google-auth-library@^10.6.2` (resolves to `10.9.0`). An unconstrained install
therefore produces **two copies** of `google-auth-library` (the nested `10.5.0`
under `googleapis-common` and the top-level `10.9.0`). At runtime this is
harmless — JavaScript duck-typing means `new gmail_v1.Gmail({ auth })` works
regardless of which copy the `OAuth2Client` came from — but TypeScript rejects
it as a type-identity mismatch ("Types have separate declarations of a private
property 'redirectUri'").

The correction is a repo-local `overrides` entry in `package.json`:

```json
"overrides": { "google-auth-library": "10.9.0" }
```

This forces Bun to install a **single** `google-auth-library@10.9.0`, so both
`oauth.ts` and the `gmail_v1.Gmail` constructor resolve the same
`OAuth2Client` type. `10.9.0` is within the same major (`10.x`) as
googleapis-common's pinned `10.5.0` — backward compatible.

**This does not change the published artifact.** The generated artifact
`package.json` carries only the `dependencies` block
(`@googleapis/gmail ^17.0.0`, `google-auth-library ^10.6.2`, `turndown ^7.2.4`) —
the `overrides` field is repo-local and does not flow into the staged artifact
(verified by `tests/packaging.test.ts`, which asserts the artifact
`dependencies` keys exactly equal the three runtime packages and that no
`overrides` leaks). At publish time, `resolvePluginDeps` installs from the
artifact ranges (no override) and may again produce two copies — `Bun.build`
inlines both into `__bundle.js`, which loads and runs identically.
`tests/google-bundle.test.ts` stages the ranges WITHOUT the override and proves
the bundle still loads and materializes all thirteen functions.

This is the same category as the google-sheets/google-tasks migrations'
"type-only corrections necessary for tsc, zero runtime change" — a
compile/install-time convenience that leaves runtime behavior and the artifact
contract byte-identical.

## Complete dependency-closure determination

The `gmail` plugin's runtime dependency closure (required for server-side
bundling via `resolvePluginDeps`):

| Package | Role | Bundled? |
|---|---|---|
| `@googleapis/gmail@^17.0.0` | direct runtime import (`gmail_v1` in gmail-functions.ts) | yes — inlined into `__bundle.js` |
| `google-auth-library@^10.6.2` | direct runtime import (`OAuth2Client` in auth-provider.ts, oauth.ts, terminal-oauth-flow.ts) | yes — inlined |
| `turndown@^7.2.4` | direct runtime import (`TurndownService` in gmail-functions.ts, HTML→markdown) | yes — inlined |
| `googleapis-common@^8.0.0` | transitive of @googleapis/gmail | yes — inlined |
| `gaxios`, `https-proxy-agent`, `agent-base`, `jws`, `jsrsasign`, … | transitive of google-auth-library / googleapis-common | yes — inlined |
| `@orgsdk/plugins` | authoring SDK, type-only imports | erased (not in runtime closure) |

`@googleapis/gmail@^17.0.0` resolves to `17.0.0`,
`google-auth-library@^10.6.2` resolves to `10.9.0`, and `turndown@^7.2.4`
resolves to the latest `7.x` — the source-declared supported ranges. There is no
root/latest drift; the artifact pins the source ranges, not newer majors.

`Bun.build` (target: `bun`, format: `esm`) produces a deterministic single-file
bundle. The daemon imports it directly — no `node_modules`, no native binary.
Verified by `tests/google-bundle.test.ts`.

### turndown runs headless under Bun

`turndown` converts an HTML string to markdown. Constructing a `TurndownService`
and calling `turndown.turndown(htmlString)` works under Bun with no DOM addon —
turndown parses the input string internally. A module-level `TurndownService`
instance is constructed at import time (`gmail-functions.ts`), so the bundle-load
smoke test (`tests/google-bundle.test.ts`) exercises this path directly. If a
future turndown major ever hard-requires a DOM addon that `Bun.build` cannot
inline, that test BLOCKS rather than hiding the issue.

### Server-process assumptions

- **Publish time:** `resolvePluginDeps` needs network access to resolve the
  Google packages and turndown from npm into a temp staging dir, then
  `Bun.build`. No native compilation step (pure JS).
- **Daemon runtime:** the standard daemon container image suffices. No system
  packages, no native addons. The Gmail client makes outbound HTTPS to
  `www.googleapis.com` at call time (gated by the connected credential's
  scopes). **No relay calls** — BYO credentials refresh locally using the
  bundled client secret.

> **Stop condition satisfied.** The user asked to "stop if bundle/load fails."
> The full Google + turndown dependency closure bundles cleanly into a single
> ESM file, loads, and the factory materializes all thirteen safe functions
> with the authProvider and GET /callback endpoint present — all with no
> network calls. The gate passes; no issue is hidden.

## Known pre-existing issues (recorded, not fixed in this release)

These predate the extraction and are frozen byte-for-byte per the migration
discipline (skill learning #6 — never combine a behavioral refactor with an
extraction):

### Security / resource concerns (frozen)

- **Arbitrary outbound Gmail API calls.** Every handler issues an authenticated
  request to `www.googleapis.com`. The scope of what an agent can do is bounded
  only by the connected credential's scopes. There is no per-call allow/deny
  list, no rate-limit guard, and no response-size cap.
- **Mutating operations.** `sendMessage`, `sendMessageWithAttachment`, and
  `replyToMessage` send email (irreversible). `modifyMessageLabels`,
  `batchModifyMessages`, `markMessageAsRead`, and `markMessageAsUnread` mutate
  labels (reversible). No confirmation gate exists at the plugin layer (approval
  gating is the harness's responsibility, not the plugin's).
- **`getMessages` fetches messages sequentially** (no batched fetch). Large
  `maxResults` can exceed the action timeout — documented in the function's
  `caveats`. Frozen.

### Code-quality concerns (frozen)

- **`gmail-functions.ts` exceeds the 300-line guideline** (1219 lines). This is
  a pre-existing monorepo file-size violation (G5). It is frozen in this
  extraction; a split into per-group modules is a separate, later release.
- **Pre-existing `as` casts and `!` non-null assertions** in several handlers
  (e.g. `creds["google-oauth"] as GoogleOAuthBundle`, `resp.data.id!`). These
  narrow the Google API's union-typed responses. They were not introduced by the
  migration and are frozen.
- **MIME multipart construction is embedded in send handlers** (`sendMessage`,
  `sendMessageWithAttachment`, `replyToMessage`) rather than exported as pure
  helpers, so it cannot be unit-tested in isolation without a refactor (out of
  scope for an extraction). The pure base64url decoder (`decodeBase64UrlToUtf8`)
  IS exported and is covered by `tests/mime-helpers.test.ts`.

## Why `@orgsdk/plugins`?

The package provides the stable, minimal, structural TypeScript contract
between plugin authors and the OrgSDK daemon — with no private daemon,
platform, storage, or database internals. See
[OrgSDK/plugins](https://github.com/OrgSDK/plugins) for the full API surface.

## Type-only contract

All imports from `@orgsdk/plugins` are `import type { … }` — erased at compile
time. The runtime plugin artifact carries **only** `@googleapis/gmail`,
`google-auth-library`, and `turndown` as dependencies. This means:

- Minimal runtime weight (three framework dependencies; the two Google
  packages' and turndown's full closure is bundled at publish time).
- Plugin source typechecks against the same contract the daemon enforces.

## Upgrading the contract version

The dependency is pinned exactly (`0.2.1`). When a new contract version is
released, update the version in `package.json`, regenerate the lockfile with
`bun install`, and confirm tests still pass. Prefer deliberate, reviewed
upgrades over floating ranges while the contract is still pre-1.0.
