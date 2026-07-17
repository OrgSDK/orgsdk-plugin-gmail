import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const MANIFEST_PATH = resolve(import.meta.dir, "..", "plugin", ".plugin.json");

async function readManifest() {
	const raw = await readFile(MANIFEST_PATH, "utf-8");
	return JSON.parse(raw) as Record<string, unknown>;
}

describe("manifest", () => {
	it("has the expected slug (name)", async () => {
		const m = await readManifest();
		expect(m.name).toBe("gmail");
	});

	it("has the bumped version 1.0.5", async () => {
		const m = await readManifest();
		expect(m.version).toBe("1.0.5");
	});

	it("declares the canonical $schema", async () => {
		const m = await readManifest();
		expect(m.$schema).toBe("https://orgsdk.ai/schemas/plugin-manifest.v1.json");
	});

	it("has a non-empty description", async () => {
		const m = await readManifest();
		expect(typeof m.description).toBe("string");
		expect((m.description as string).length).toBeGreaterThan(0);
	});

	it("declares entry as index.ts", async () => {
		const m = await readManifest();
		expect(m.entry).toBe("index.ts");
	});

	it("declares oauth2 auth with the shared google-oauth provider key", async () => {
		const m = await readManifest();
		const auth = m.auth as Record<string, unknown>;
		expect(auth.type).toBe("oauth2");
		expect(auth.provider).toBe("google-oauth");
		expect(typeof auth.label).toBe("string");
		expect((auth.label as string).length).toBeGreaterThan(0);
		expect(typeof auth.hint).toBe("string");
		expect((auth.hint as string).length).toBeGreaterThan(0);
	});

	// Gmail uses the RESTRICTED https://mail.google.com/ scope. It cannot be
	// merged with the google-sheets union (spreadsheets + tasks) — Gmail is a
	// separate restricted-scope consent (CASA audit). Asserting the exact
	// single scope guards against accidentally broadening or narrowing it.
	it("declares exactly the restricted mail scope (no union, no broadening)", async () => {
		const m = await readManifest();
		const auth = m.auth as Record<string, unknown>;
		expect(auth.scopes).toEqual(["https://mail.google.com/"]);
	});

	// gmail owns its OWN BYO callback (the redirect_uri is bound to
	// /plugins/gmail/callback). It does NOT reuse google-sheets' callback —
	// the restricted-scope consent is Gmail-specific.
	it("declares the /callback path (owns its own BYO callback)", async () => {
		const m = await readManifest();
		const auth = m.auth as Record<string, unknown>;
		expect(auth.callbackPath).toBe("/callback");
	});

	// gmail is BYO-ONLY. It MUST NOT declare firstParty: true — the restricted
	// scope cannot be satisfied by the relay-held first-party client (no CASA
	// assessment on OrgSDK's client). Asserting the ABSENCE of firstParty guards
	// against accidentally enabling one-click connect, which would then fail at
	// the consent screen and confuse tenants.
	it("does NOT declare firstParty (restricted scope, BYO only)", async () => {
		const m = await readManifest();
		const auth = m.auth as Record<string, unknown>;
		expect(auth.firstParty).toBeUndefined();
	});

	it("declares marketplace metadata with the source-repo provenance link", async () => {
		const m = await readManifest();
		const mp = m.marketplace as Record<string, unknown>;
		expect(mp.displayName).toBe("Gmail");
		expect(mp.category).toBe("Communication");
		expect(Array.isArray(mp.tags)).toBe(true);
		expect(mp.tagline).toBeDefined();
		expect(Array.isArray(mp.useCases)).toBe(true);
		expect(typeof mp.permissionsSummary).toBe("string");
		const links = mp.links as Record<string, string>;
		expect(links.sourceRepo).toBe(
			"https://github.com/OrgSDK/orgsdk-plugin-gmail",
		);
		expect(links.homepage).toBe("https://mail.google.com");
		expect(links.docs).toBe("https://developers.google.com/gmail/api");
	});
});
