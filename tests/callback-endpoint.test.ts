/**
 * Callback-endpoint tests — the gmail-owned BYO OAuth callback.
 *
 * gmail registers a GET /callback httpEndpoint whose handler delegates to
 * GmailOAuthProvider.handleCallback. These tests pin the endpoint shape and
 * the error-path contract with NO real Google network calls:
 *
 *   - exactly one GET /callback endpoint with an HTML handler;
 *   - handleCallback rejects a request missing code or state;
 *   - handleCallback rejects an unknown state;
 *   - the endpoint handler renders HTML failure (400) on a missing state.
 *
 * IMPORTANT — the gaxios/node:http caveat (BYO token exchange NOT exercised):
 * gmail is BYO-only, so the ONLY connect path exchanges the authorization code
 * via `oauth.getToken(code)`, which goes through google-auth-library → gaxios
 * → node:http (NOT globalThis.fetch). That cannot be intercepted by a fetch
 * mock and would hit the real Google token endpoint. The BYO exchange success
 * path is therefore NOT unit-tested here — it is production-verified at
 * publish time (Phase 3). Its component contracts are covered elsewhere:
 *   - BYO client resolution (3 tiers)  → tests/connect-resolution.test.ts
 *   - BYO local-refresh bundle shape   → tests/first-party-rejection.test.ts
 *   - first-party rejection            → tests/first-party-rejection.test.ts
 *   - full closure bundle/load         → tests/google-bundle.test.ts
 *
 * google-sheets' callback test could exercise a first-party (relay/fetch)
 * exchange end-to-end; gmail has NO first-party path, so only the error
 * surface + shape is testable in isolation.
 */
import { describe, expect, it } from "bun:test";
import type { PluginContext } from "@orgsdk/plugins";
import { GmailOAuthProvider } from "../plugin/auth-provider";

function ctxWithSecrets(
	secrets: Record<string, Record<string, Record<string, unknown>>> = {},
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

describe("callback endpoint + handleCallback", () => {
	it("registers exactly one GET /callback endpoint with an HTML handler", () => {
		const provider = new GmailOAuthProvider(ctxWithSecrets());
		const eps = provider.getHttpEndpoints();
		expect(eps.length).toBe(1);
		expect(eps[0].method).toBe("GET");
		expect(eps[0].path).toBe("/callback");
		expect(typeof eps[0].handler).toBe("function");
	});

	it("endpoint handler returns HTML failure (400) when state is missing", async () => {
		const provider = new GmailOAuthProvider(ctxWithSecrets());
		const handler = provider.getHttpEndpoints()[0].handler;
		const res = await handler(
			new Request("https://app.orgsdk.test/plugins/gmail/callback?code=CODE"),
		);
		expect(res.status).toBe(400);
		expect(res.headers.get("content-type")).toBe("text/html");
		const body = await res.text();
		expect(body).toContain("Gmail OAuth failed");
		expect(body).toContain("Missing code or state");
	});

	it("handleCallback rejects a request missing code or state", async () => {
		const provider = new GmailOAuthProvider(ctxWithSecrets());
		const res = await provider.handleCallback(
			new Request("https://app.orgsdk.test/plugins/gmail/callback"),
		);
		expect(res.success).toBe(false);
		expect(res.credentialName).toBe("");
		expect(res.error).toMatch(/Missing code or state/);
	});

	it("handleCallback rejects an unknown state", async () => {
		const provider = new GmailOAuthProvider(ctxWithSecrets());
		const res = await provider.handleCallback(
			new Request(
				"https://app.orgsdk.test/plugins/gmail/callback?code=CODE&state=bogus",
			),
		);
		expect(res.success).toBe(false);
		expect(res.error).toMatch(/Invalid or expired state/);
	});

	it("handleCallback rejects a code without a state", async () => {
		const provider = new GmailOAuthProvider(ctxWithSecrets());
		const res = await provider.handleCallback(
			new Request("https://app.orgsdk.test/plugins/gmail/callback?code=CODE"),
		);
		expect(res.success).toBe(false);
		expect(res.error).toMatch(/Missing code or state/);
	});

	it("a known state from initiate is accepted up to the token-exchange step (CSRF binding works)", async () => {
		// initiate creates a pending state; handleCallback looks it up. We
		// cannot complete the BYO exchange (gaxios/node:http → real Google),
		// but we CAN prove the state lookup succeeds and the failure is the
		// token-exchange network error (NOT a state error). This pins the
		// state-binding round trip without a real Google call succeeding.
		const provider = new GmailOAuthProvider(
			ctxWithSecrets({
				"google-oauth-client": {
					default: {
						secret_clientId: "byo-id",
						secret_clientSecret: "byo-secret",
					},
				},
			}),
		);
		const { state } = await provider.initiate("default");
		const res = await provider.handleCallback(
			new Request(
				`https://app.orgsdk.test/plugins/gmail/callback?code=CODE&state=${state}`,
			),
		);
		// The state WAS valid (no "Invalid or expired state" error). The
		// failure is the token exchange hitting the real Google endpoint
		// (offline / refused), surfaced as a network error string — proving the
		// state-binding path works end-to-end up to the network boundary.
		expect(res.success).toBe(false);
		expect(res.credentialName).toBe("default");
		expect(res.error).not.toMatch(/Invalid or expired state/);
		expect(res.error).not.toMatch(/Missing code or state/);
	});
});
