# @orgsdk/plugin-gmail

Official OrgSDK plugin for Gmail — search, threads, labels, attachments, send, and
reply for agent workflows. Thirteen safe functions exposing the Gmail REST
surface under the **restricted** `https://mail.google.com/` scope. This plugin is
**BYO-only**: it owns its own `GET /callback` connect flow but rejects
first-party (one-click) tokens — Gmail's restricted scope requires a CASA
security assessment, so the tenant must supply their own Google OAuth client.

[![CI](https://github.com/OrgSDK/orgsdk-plugin-gmail/actions/workflows/ci.yml/badge.svg)](https://github.com/OrgSDK/orgsdk-plugin-gmail/actions/workflows/ci.yml)

## Repository layout

```
orgsdk-plugin-gmail/
├── .github/workflows/
│   ├── ci.yml                 # calls the shared reusable CI workflow (OrgSDK/plugins)
│   └── publish-catalog.yml    # calls the shared reusable publish workflow (opt-in; manual dry-run)
├── plugin/                    # the publishable plugin folder
│   ├── .plugin.json           # manifest (slug, version, oauth2 google-oauth auth, BYO scope, marketplace)
│   ├── index.ts               # entry — factory (ctx) => PluginModule (owns authProvider + /callback)
│   ├── gmail-functions.ts     # thirteen functions: search, threads, labels, send, reply, attachments
│   ├── auth-provider.ts       # GmailOAuthProvider — initiate/handleCallback/configure/authSetup (BYO 3-tier resolution, no first-party)
│   ├── oauth.ts               # google-oauth bundle → OAuth2Client (BYO local refresh; REJECTS first-party)
│   ├── terminal-oauth-flow.ts # CLI authSetup (interactive paste-the-code flow)
│   ├── docs/overview.md       # plugin-local docs
│   └── guides/usage-patterns.md  # agent-facing composition patterns
├── tests/                     # bun:test — manifest, purity, shape, packaging, google-bundle smoke, first-party-rejection, connect-resolution, callback-endpoint, mime-helpers
├── docs/                      # contract migration, release/promotion contract
├── package.json
├── tsconfig.json
├── biome.json
└── README.md
```

The `plugin/` folder is the canonical source for the `gmail` plugin; it is
published to the OrgSDK catalog on merge to `main` when opted in via the
`ORGSDK_ENABLE_CATALOG_PUBLISH` repo variable (see [docs/release.md](docs/release.md)).

## Local development

Requires [Bun](https://bun.sh) ≥ 1.3.x.

```bash
# Install (frozen lockfile in CI; dev: generates one)
bun install

# Lint + format check
bun run check

# Typecheck (no emit)
bun run typecheck

# Run tests
bun run test

# Validate manifest + source purity (orgsdk-plugin validate)
bun run validate

# Stage distributable artifact into dist/ (orgsdk-plugin package)
bun run package

# Full build pipeline (typecheck → validate → package)
bun run build
```

The `validate`, `package`, `version-guard`, and `publish` npm scripts delegate to
the [`orgsdk-plugin`](https://www.npmjs.com/package/@orgsdk/plugins) CLI shipped
by the `@orgsdk/plugins` dev dependency. There are no local management scripts.

## Functions

Thirteen functions. Five are readonly (read-only Gmail GETs), eight are write
(mutating). Five readonly functions are tagged `discovery` (safe to use in
exploration workflows).

| Group | Readonly | Write |
|---|---|---|
| Read (5) | getMessages, getMessage, getThread, listLabels, getMessageAttachment | — |
| Labels (3) | — | ensureLabel, modifyMessageLabels, batchModifyMessages |
| Read state (2) | — | markMessageAsRead, markMessageAsUnread |
| Send (3) | — | sendMessage, sendMessageWithAttachment, replyToMessage |

Every function declares `requiredCredentials: ["google-oauth"]` — none are
callable until the shared credential is connected.

## Credentials & the restricted Gmail scope

Gmail uses the **restricted** `https://mail.google.com/` scope. Google classifies
restricted scopes as requiring a CASA security assessment, so **first-party
(one-click) OAuth is not available**. The tenant must supply their own Google
OAuth client. At runtime, the `source` discriminator on the stored
`google-oauth` bundle is checked: a bundle stamped `source: "first-party"` (issued
by google-sheets' one-click connect) is **rejected with a clear error** rather
than failing opaquely inside the Gmail API call — it carries no client secret and
lacks the Gmail scope.

| Provider | Type | Connect method |
|---|---|---|
| `google-oauth` | oauth2 | **BYO only.** Paste your own Google OAuth client JSON. The client's granted scopes must include `https://mail.google.com/`. First-party one-click connect is **not** offered for Gmail. |

### Combining Gmail + Sheets/Tasks

The provider key is the shared `google-oauth`, so a single BYO client whose
granted scopes cover Gmail + Sheets + Tasks serves this plugin **and**
`google-sheets`/`google-tasks`. The first-party client (one-click in
google-sheets) covers only Sheets + Tasks — never Gmail — and is refused here.

### BYO resolution (3 tiers, no first-party fallback)

Client resolution (first hit wins; returns `null` if none configured):

1. `google-oauth-client/default` (tenant shared client)
2. `google-oauth-client/<name>` (tenant per-credential client)
3. `google-oauth/<name>` client fields (legacy: client baked into token)

There is **no** first-party relay fallback for Gmail. If no BYO client is found,
`initiate` throws a connect-prompt error naming the three tiers it checked.

### The `source` discriminator (frozen contract)

- **`source: "first-party"`** — **rejected** by `getGoogleOAuth2Client`. A
  first-party token (from google-sheets' one-click) cannot access Gmail.
- **`source: "byo"`** (or absent/legacy) — the tenant's own OAuth client. The
  plugin refreshes locally using the bundled `client_secret`.

The provider key (`google-oauth`) and the `source` discriminator must never
change — google-sheets, google-tasks, and the relay all depend on them. See
[docs/contract-migration.md](docs/contract-migration.md).

## Manifest & version rules

- The manifest lives at `plugin/.plugin.json`.
- `version` is the **source of truth** for the catalog — bump it on every
  publishable content change (the CI version guard enforces this).
- `package.json` → `version` is kept in sync with the manifest (enforced by the
  version guard).
- Versions are **write-once** in the catalog: re-publishing the same
  `(slug, version)` with identical content is idempotent; differing content is
  rejected (HTTP 409). Treat every publish as forward-only.
- See [docs/release.md](docs/release.md) for the automatic publish model and
  required repository settings.

## CI/CD

CI and catalog publishing delegate to centrally maintained **reusable
workflows** in [OrgSDK/plugins](https://github.com/OrgSDK/plugins), pinned to an
immutable commit. The caller workflows (`.github/workflows/`) only wire up
triggers, the opt-in gate, artifact names, and secrets — no plugin mechanics
are duplicated. See the
[reusable-workflows docs](https://github.com/OrgSDK/plugins/blob/main/docs/reusable-workflows.md)
for the full contract.

## Runtime dependencies: @googleapis/gmail + google-auth-library + turndown

`gmail-functions.ts` imports `{ gmail_v1 }` from
[`@googleapis/gmail`](https://www.npmjs.com/package/@googleapis/gmail)
(`^17.0.0`) and constructs a `gmail_v1.Gmail` client; `auth-provider.ts`,
`oauth.ts`, and `terminal-oauth-flow.ts` import `{ OAuth2Client }` from
[`google-auth-library`](https://www.npmjs.com/package/google-auth-library)
(`^10.6.2`); `gmail-functions.ts` imports `TurndownService` from
[`turndown`](https://www.npmjs.com/package/turndown) (`^7.2.4`) to convert HTML
email bodies to markdown. At publish time, the platform's `resolvePluginDeps`
bundles the plugin entry plus all three packages (and their full transitive
closure) into a single `__bundle.js` ESM file via `Bun.build`. The daemon
imports that bundle directly — there is **no runtime node_modules resolution**
in the tenant container.

See [docs/contract-migration.md](docs/contract-migration.md) for the full
dependency-closure analysis and the install-resolution correction.

## Security constraints

- This plugin owns its own connect flow — it registers an `authProvider`
  (`GmailOAuthProvider`) and the `GET /callback` endpoint. The shared
  `google-oauth` credential is injected per-call as the leading `credentials`
  argument. **First-party tokens are explicitly rejected** at the auth chokepoint
  (`getGoogleOAuth2Client` in `oauth.ts`) — a restricted-scope consent boundary
  that cannot be satisfied by the relay-held client.
- Source purity is enforced: no imports from private `@orgsdk/*` packages, no
  cross-plugin imports (cloud-mode plugins must be self-contained because the
  materialiser blocks sibling imports), no runtime value imports from the
  authoring SDK. The `validate` script and `tests/purity.test.ts` guard this.
- Publish credentials (`ORGSDK_PUBLISH_TOKEN`) live as a GitHub secret
  (repository-level or `catalog-publish` environment); they are never committed
  to the repo. See [docs/release.md](docs/release.md).

> **Pre-existing security/resource concerns (frozen, not refactored in this
> extraction).** Every handler issues an authenticated Gmail request with no
> per-call allow/deny list, rate-limit guard, or response-size cap. The scope of
> what an agent can do is bounded only by the connected credential's scopes.
> `sendMessage`, `sendMessageWithAttachment`, and `replyToMessage` are mutating;
> `modifyMessageLabels`/`batchModifyMessages`/`markMessage*` mutate labels
> (reversible). These behaviors are frozen verbatim per the migration discipline.
> See [docs/contract-migration.md](docs/contract-migration.md#known-pre-existing-issues-recorded-not-fixed-in-this-release).

## Authoring contract & runtime dependencies

The plugin authoring types come from the public
[`@orgsdk/plugins`](https://www.npmjs.com/package/@orgsdk/plugins) npm package,
imported type-only (`import type { … } from "@orgsdk/plugins"`). The SDK is a
dev-only dependency. The runtime artifact carries **three** runtime dependencies
— `@googleapis/gmail` (`^17.0.0`), `google-auth-library` (`^10.6.2`), and
`turndown` (`^7.2.4`).

See [docs/contract-migration.md](docs/contract-migration.md).

## Source attribution

Extracted from the OrgSDK monorepo at:

- **Source path:** `packages/plugins/src/gmail/`
- **Source version:** `1.0.1`

No plugin behavior changed in this extraction — only the type-only import
specifiers (`orgsdk/plugins` → `@orgsdk/plugins`), the manifest `$schema`,
`version`, and `marketplace.links.sourceRepo` were added.

## License

Proprietary — All rights reserved. This source is the confidential property
of OrgSDK. No part of this repository may be reproduced, distributed, or
transmitted in any form without the prior written permission of OrgSDK.
Unauthorized use, modification, or redistribution is strictly prohibited.
