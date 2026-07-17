/**
 * First-party-rejection + BYO local-refresh tests — gmail's defining contract.
 *
 * gmail uses the RESTRICTED https://mail.google.com/ scope, which requires a
 * CASA security assessment. It CANNOT use the relay-held first-party client
 * (google-sheets' one-click connect). The single auth chokepoint —
 * `getGoogleOAuth2Client` in oauth.ts — enforces this boundary:
 *
 *   - `source: "first-party"` → REJECTED with a clear, actionable error. A
 *     first-party token (issued by google-sheets) carries no client secret and
 *     lacks the Gmail scope, so it would fail opaquely inside the Gmail API
 *     call. The plugin refuses it up front instead.
 *   - `source: "byo"` (or absent/legacy) → builds an OAuth2Client with the
 *     tenant's own client secret for local refresh.
 *
 * Network caveat (gaxios/node:http, NOT globalThis.fetch): constructing an
 * OAuth2Client and calling setCredentials does NOT make a network call — the
 * refresh happens lazily on the first authenticated API request, which these
 * tests never trigger. So these tests run with NO real Google token exchange.
 * global `fetch` is stubbed anyway to catch any stray relay attempt (gmail
 * should never call the relay — it is BYO only).
 *
 * These tests exercise oauth.ts directly (imported from source, not the
 * bundle).
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { GoogleOAuthBundle } from "../plugin/oauth";
import { getGoogleOAuth2Client } from "../plugin/oauth";

const ORIGINAL_FETCH = globalThis.fetch;

describe("first-party rejection + BYO local refresh (the gmail contract)", () => {
	let fetchMock: ReturnType<typeof mock>;

	beforeEach(() => {
		// gmail is BYO-only and should NEVER call the relay. Stub fetch to a
		// failing mock so any stray relay attempt is loudly caught (fetchMock
		// call count is asserted to be zero on every BYO path).
		fetchMock = mock(() =>
			Promise.resolve(new Response("{}", { status: 404 })),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = ORIGINAL_FETCH;
	});

	// ── THE defining gmail negative: first-party tokens are REJECTED ─────────
	it("first-party bundle is REJECTED (restricted scope, BYO only)", async () => {
		const bundle: GoogleOAuthBundle = {
			source: "first-party",
			secret_clientId: "fp-client-id",
			secret_refreshToken: "rt_fp_gmail",
		};
		await expect(getGoogleOAuth2Client(bundle)).rejects.toThrow(
			/first-party \(Sheets\/Tasks only\) and cannot access Gmail/,
		);
		await expect(getGoogleOAuth2Client(bundle)).rejects.toThrow(
			/connect your own Google OAuth client for the gmail plugin/,
		);
		// Rejection happens BEFORE any network call.
		expect(fetchMock.mock.calls.length).toBe(0);
	});

	it("first-party bundle is rejected even if it carries a refresh token + secret", async () => {
		// A misconfigured/legacy first-party bundle that somehow has a secret
		// is STILL rejected — the source discriminator is authoritative.
		const bundle: GoogleOAuthBundle = {
			source: "first-party",
			secret_clientId: "fp-id",
			secret_clientSecret: "leaked-secret",
			secret_refreshToken: "rt_fp",
		};
		await expect(getGoogleOAuth2Client(bundle)).rejects.toThrow(
			/cannot access Gmail/,
		);
		expect(fetchMock.mock.calls.length).toBe(0);
	});

	// ── BYO local refresh: client built WITHOUT any network call ────────────
	it("BYO bundle builds a local-refresh client WITHOUT any fetch call", async () => {
		const bundle: GoogleOAuthBundle = {
			secret_clientId: "byo-client-id",
			secret_clientSecret: "byo-client-secret",
			secret_refreshToken: "rt_byo_unique_1",
		};
		const client = await getGoogleOAuth2Client(bundle);
		// No network call: constructing OAuth2Client + setCredentials is local.
		// (The refresh happens lazily on the first authenticated API request,
		// via gaxios/node:http — never triggered here.)
		expect(fetchMock.mock.calls.length).toBe(0);
		// The refresh token is staged for local refresh (lazy, never triggered).
		expect(client.credentials.refresh_token).toBe("rt_byo_unique_1");
		expect(client.credentials.access_token).toBeUndefined();
	});

	it("BYO bundle with no refresh token throws the connect prompt (and no fetch)", async () => {
		const bundle: GoogleOAuthBundle = {
			secret_clientId: "byo-client-id",
			secret_clientSecret: "byo-client-secret",
		};
		await expect(getGoogleOAuth2Client(bundle)).rejects.toThrow(
			/Missing google-oauth refresh token/,
		);
		expect(fetchMock.mock.calls.length).toBe(0);
	});

	it("absent source is treated as byo (legacy bundles refresh locally)", async () => {
		// No `source` field — legacy/older credentials behave as BYO and are
		// NOT rejected (only an explicit first-party stamp is refused).
		const bundle: GoogleOAuthBundle = {
			secret_clientId: "legacy-id",
			secret_clientSecret: "legacy-secret",
			secret_refreshToken: "rt_legacy_unique_3",
		};
		const client = await getGoogleOAuth2Client(bundle);
		expect(fetchMock.mock.calls.length).toBe(0);
		expect(client.credentials.refresh_token).toBe("rt_legacy_unique_3");
	});

	it("byo source is explicitly accepted (not just absent-source fallback)", async () => {
		const bundle: GoogleOAuthBundle = {
			source: "byo",
			secret_clientId: "byo-id",
			secret_clientSecret: "byo-secret",
			secret_refreshToken: "rt_byo_explicit",
		};
		const client = await getGoogleOAuth2Client(bundle);
		expect(fetchMock.mock.calls.length).toBe(0);
		expect(client.credentials.refresh_token).toBe("rt_byo_explicit");
	});
});
