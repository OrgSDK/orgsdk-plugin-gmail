/**
 * Connect-resolution tests — the gmail-owned BYO connect contract.
 *
 * gmail owns its own GET /callback but is BYO-ONLY. Four frozen invariants are
 * pinned here, with NO real Google or relay network calls (the credential
 * store is a mock; generateAuthUrl is a pure URL builder):
 *
 *  1. RESTRICTED SCOPE — initiate requests ONLY https://mail.google.com/
 *     (never the sheets/tasks union — that is google-sheets' contract).
 *  2. BYO 3-TIER RESOLUTION (first hit wins):
 *       google-oauth-client/default → google-oauth-client/<name>
 *       → google-oauth/<name> client fields.
 *  3. NO FIRST-PARTY FALLBACK — when no BYO client is configured, resolution
 *     returns null and initiate THROWS a connect-prompt error. gmail never
 *     contacts the relay for a client (unlike google-sheets).
 *  4. NO isFirstPartyAvailable — the BYO-only provider does not expose the
 *     first-party probe surface at all.
 *
 * The redirect_uri is bound to /plugins/gmail/callback (gmail's own callback
 * path — it does NOT reuse google-sheets').
 *
 * Resolution is exercised via `provider.initiate(name)`, which calls the
 * private `resolveByoClient` and either returns `{ authUrl, state }` (client
 * found — generateAuthUrl is pure, no network) or throws (no client). The
 * resolved client_id is observable in the generated auth URL's query string.
 */
import { describe, expect, it } from "bun:test";
import type { PluginContext } from "@orgsdk/plugins";
import { GmailOAuthProvider } from "../plugin/auth-provider";

/** Build a ctx whose credential.getSecrets looks up a (provider,name) map. */
function ctxWithSecrets(
	secrets: Record<string, Record<string, Record<string, unknown>>>,
	publicBaseUrl = "https://app.orgsdk.test",
): PluginContext {
	return {
		stores: {
			credential: {
				get: async () => null,
				list: async () => [],
				upsert: async () => {},
				delete: async () => {},
				getSecrets: async (provider: string, name: string) =>
					secrets[provider]?.[name] ?? null,
				setSecrets: async () => {},
			},
			config: {
				list: async () => [],
				get: async () => null,
				set: async () => ({ key: "", value: {}, updatedAt: null }),
				delete: async () => {},
			},
		},
		publicBaseUrl,
		logger: {
			trace() {},
			debug() {},
			info() {},
			warn() {},
			error() {},
			fatal() {},
			child() {
				return this;
			},
		},
	};
}

describe("connect resolution (BYO 3 tiers, restricted scope, NO first-party fallback)", () => {
	// ── BYO tier 1: google-oauth-client/default wins ────────────────────────
	it("BYO tier 1: google-oauth-client/default wins", async () => {
		const ctx = ctxWithSecrets({
			"google-oauth-client": {
				default: {
					secret_clientId: "byo-default-id",
					secret_clientSecret: "byo-default-secret",
				},
			},
		});
		const provider = new GmailOAuthProvider(ctx);
		const { authUrl } = await provider.initiate("work");
		const url = new URL(authUrl);
		// The resolved default client_id appears in the consent URL.
		expect(url.searchParams.get("client_id")).toBe("byo-default-id");
		// redirect_uri bound to gmail's own callback path.
		expect(url.searchParams.get("redirect_uri")).toBe(
			"https://app.orgsdk.test/plugins/gmail/callback",
		);
	});

	it("BYO tier 2: google-oauth-client/<name> wins over google-oauth/<name>", async () => {
		const ctx = ctxWithSecrets({
			"google-oauth-client": {
				work: {
					secret_clientId: "byo-named-id",
					secret_clientSecret: "byo-named-secret",
				},
			},
			"google-oauth": {
				work: {
					secret_clientId: "legacy-id",
					secret_clientSecret: "legacy-secret",
					secret_refreshToken: "rt",
				},
			},
		});
		const provider = new GmailOAuthProvider(ctx);
		const { authUrl } = await provider.initiate("work");
		expect(new URL(authUrl).searchParams.get("client_id")).toBe("byo-named-id");
	});

	it("BYO tier 3: google-oauth/<name> client fields are used as legacy fallback", async () => {
		const ctx = ctxWithSecrets({
			"google-oauth": {
				work: {
					secret_clientId: "legacy-id",
					secret_clientSecret: "legacy-secret",
					secret_refreshToken: "rt",
				},
			},
		});
		const provider = new GmailOAuthProvider(ctx);
		const { authUrl } = await provider.initiate("work");
		expect(new URL(authUrl).searchParams.get("client_id")).toBe("legacy-id");
	});

	it("BYO tier 1 (default) serves a differently-named credential (shared client)", async () => {
		// The default client covers all credential names — a tenant with one
		// OAuth client connects once and uses any credential name. This is the
		// coexistence contract with sheets/tasks (single shared client).
		const ctx = ctxWithSecrets({
			"google-oauth-client": {
				default: {
					secret_clientId: "shared-id",
					secret_clientSecret: "shared-secret",
				},
			},
		});
		const provider = new GmailOAuthProvider(ctx);
		const { authUrl } = await provider.initiate("any-name-here");
		expect(new URL(authUrl).searchParams.get("client_id")).toBe("shared-id");
	});

	it("BYO requires BOTH client_id and client_secret (partial entry is skipped → no client)", async () => {
		const ctx = ctxWithSecrets({
			"google-oauth-client": {
				default: { secret_clientId: "only-id" }, // no secret → skipped
			},
		});
		const provider = new GmailOAuthProvider(ctx);
		// Partial BYO falls through all three tiers → null → initiate throws.
		// (NOT a first-party fallback — gmail has none.)
		await expect(provider.initiate("default")).rejects.toThrow(
			/requires your own Google OAuth client/,
		);
	});

	// ── NO first-party fallback: no BYO → initiate throws (never the relay) ──
	it("no BYO configured → initiate throws the connect prompt (NO relay fallback)", async () => {
		const provider = new GmailOAuthProvider(ctxWithSecrets({}));
		await expect(provider.initiate("default")).rejects.toThrow(
			/Gmail requires your own Google OAuth client \(restricted scope\)/,
		);
		// The error names all three tiers it checked.
		await expect(provider.initiate("default")).rejects.toThrow(
			/google-oauth-client\/default.*google-oauth-client\/default.*google-oauth\/default/s,
		);
	});

	// ── Restricted scope: ONLY https://mail.google.com/ (never the union) ────
	it("initiate requests ONLY the restricted mail scope (not the sheets/tasks union)", async () => {
		const ctx = ctxWithSecrets({
			"google-oauth-client": {
				default: {
					secret_clientId: "byo-id",
					secret_clientSecret: "byo-secret",
				},
			},
		});
		const provider = new GmailOAuthProvider(ctx);
		const { authUrl } = await provider.initiate("default");
		const url = new URL(authUrl);
		const scope = url.searchParams.get("scope") ?? "";
		expect(scope).toBe("https://mail.google.com/");
		// consent + offline so a refresh_token is returned.
		expect(url.searchParams.get("access_type")).toBe("offline");
		expect(url.searchParams.get("prompt")).toBe("consent");
		expect(url.searchParams.get("state")).toBeTruthy();
	});

	it("initiate returns a state token (for CSRF binding on the callback)", async () => {
		const ctx = ctxWithSecrets({
			"google-oauth-client": {
				default: {
					secret_clientId: "byo-id",
					secret_clientSecret: "byo-secret",
				},
			},
		});
		const provider = new GmailOAuthProvider(ctx);
		const { state, authUrl } = await provider.initiate("default");
		expect(typeof state).toBe("string");
		expect(state.length).toBeGreaterThan(0);
		// The state is echoed in the consent URL for round-trip verification.
		expect(new URL(authUrl).searchParams.get("state")).toBe(state);
	});

	// ── BYO-only surface: NO isFirstPartyAvailable ──────────────────────────
	it("the provider does NOT expose isFirstPartyAvailable (BYO only)", () => {
		const provider = new GmailOAuthProvider(ctxWithSecrets({}));
		// gmail is BYO-only — it must not advertise a first-party probe.
		expect(
			(provider as unknown as Record<string, unknown>).isFirstPartyAvailable,
		).toBeUndefined();
	});
});
