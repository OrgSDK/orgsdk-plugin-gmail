/**
 * Plugin shape / contract tests — the implementation-equivalence gate.
 *
 * Imports the real entry through Bun's module system (no daemon, no DB) and
 * exercises the factory with a no-op PluginContext. These tests pin:
 *
 *  - the exact thirteen function names/count;
 *  - the `google-oauth` credential requirement on every function;
 *  - the readonly/write split (five readonly, eight write) + discovery subset;
 *  - the PRESENCE of an authProvider (GmailOAuthProvider) owning its own BYO
 *    callback;
 *  - the PRESENCE of the GET /callback httpEndpoint;
 *  - the authProvider method surface: initiate, handleCallback, configure,
 *    authSetup — and the ABSENCE of isFirstPartyAvailable (BYO only);
 *  - the absence of a Zod config block (no tenant_config).
 *
 * Behavioral parity with monorepo `packages/plugins/src/gmail` v1.0.1:
 *  - read ops (5): getMessages, getMessage, getThread, listLabels,
 *    getMessageAttachment
 *  - label ops (3): ensureLabel, modifyMessageLabels, batchModifyMessages
 *  - read-state ops (2): markMessageAsRead, markMessageAsUnread
 *  - send ops (3): sendMessage, sendMessageWithAttachment, replyToMessage
 *  - requiredCredentials: ["google-oauth"] on every function
 *  - authProvider: GmailOAuthProvider (owns its own BYO callback)
 */
import { describe, expect, it } from "bun:test";
import type { PluginContext, PluginModule } from "@orgsdk/plugins";

const EXPECTED_FUNCTIONS = [
	// read operations
	"getMessages",
	"getMessage",
	"getThread",
	"listLabels",
	"getMessageAttachment",
	// label operations
	"ensureLabel",
	"modifyMessageLabels",
	"batchModifyMessages",
	// read-state operations
	"markMessageAsRead",
	"markMessageAsUnread",
	// send operations
	"sendMessage",
	"sendMessageWithAttachment",
	"replyToMessage",
] as const;

// Functions tagged readonly in the monorepo source (metadata.readonly === true
// AND tags include "readonly"). All five are read GETs.
const READONLY_FUNCTIONS = [
	"getMessages",
	"getMessage",
	"getThread",
	"listLabels",
	"getMessageAttachment",
] as const;

// Functions tagged discovery (metadata.discovery === true AND tags include
// "discovery"). Discovery is a strict subset of readonly. getMessageAttachment
// is readonly but NOT discovery (it returns binary bytes, not exploration data).
const DISCOVERY_FUNCTIONS = [
	"getMessages",
	"getMessage",
	"getThread",
	"listLabels",
] as const;

const noopCtx: PluginContext = {
	stores: {
		credential: {
			get: async () => null,
			list: async () => [],
			upsert: async () => {},
			delete: async () => {},
			getSecrets: async () => null,
			setSecrets: async () => {},
		},
		config: {
			list: async () => [],
			get: async () => null,
			set: async () => ({ key: "", value: {}, updatedAt: null }),
			delete: async () => {},
		},
	},
	publicBaseUrl: "http://localhost:3000",
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

async function loadPlugin(ctx: PluginContext = noopCtx): Promise<PluginModule> {
	const mod = await import("../plugin/index");
	const factory = mod.default as (ctx: PluginContext) => PluginModule;
	return factory(ctx);
}

describe("plugin shape", () => {
	it("factory returns a module with safeFunctions", async () => {
		const mod = await loadPlugin();
		expect(Array.isArray(mod.safeFunctions)).toBe(true);
		expect(mod.safeFunctions?.length).toBeGreaterThan(0);
	});

	it("exposes exactly the thirteen expected safe functions (no more, no less)", async () => {
		const mod = await loadPlugin();
		const names = (mod.safeFunctions ?? []).map((f) => f.name).sort();
		expect(names).toEqual([...EXPECTED_FUNCTIONS].sort());
		expect((mod.safeFunctions ?? []).length).toBe(13);
	});

	it('every function declares requiredCredentials: ["google-oauth"]', async () => {
		const mod = await loadPlugin();
		for (const fn of mod.safeFunctions ?? []) {
			expect(fn.requiredCredentials).toEqual(["google-oauth"]);
		}
	});

	it("every function is categorized under google", async () => {
		const mod = await loadPlugin();
		for (const fn of mod.safeFunctions ?? []) {
			expect(fn.metadata?.category).toBe("google");
		}
	});

	it("every function is tagged auth (all require the google-oauth credential)", async () => {
		const mod = await loadPlugin();
		for (const fn of mod.safeFunctions ?? []) {
			expect(fn.metadata?.tags).toContain("auth");
		}
	});

	it("every function name is unique within the plugin", async () => {
		const mod = await loadPlugin();
		const names = (mod.safeFunctions ?? []).map((f) => f.name);
		expect(new Set(names).size).toBe(names.length);
	});

	it("exactly the five readonly functions carry readonly flag + tag", async () => {
		const mod = await loadPlugin();
		const fns = mod.safeFunctions ?? [];
		const readonlyFns = fns.filter((f) => f.metadata?.readonly === true);
		expect(readonlyFns.length).toBe(READONLY_FUNCTIONS.length);
		const names = new Set(readonlyFns.map((f) => f.name));
		for (const expected of READONLY_FUNCTIONS) {
			expect(names.has(expected)).toBe(true);
		}
		for (const fn of readonlyFns) {
			expect(fn.metadata?.tags).toContain("readonly");
		}
	});

	it("the eight write functions do NOT carry readonly (mutating)", async () => {
		const mod = await loadPlugin();
		const fns = mod.safeFunctions ?? [];
		const writeFns = fns.filter((f) => f.metadata?.readonly !== true);
		expect(writeFns.length).toBe(8);
		const readonlySet = new Set<string>(READONLY_FUNCTIONS);
		for (const fn of writeFns) {
			expect(readonlySet.has(fn.name)).toBe(false);
		}
		// Sanity: readonly ∪ write === all 13.
		expect(writeFns.length + READONLY_FUNCTIONS.length).toBe(13);
	});

	it("exactly the four discovery functions carry discovery flag + tag", async () => {
		const mod = await loadPlugin();
		const byName = new Map((mod.safeFunctions ?? []).map((f) => [f.name, f]));
		for (const name of DISCOVERY_FUNCTIONS) {
			const fn = byName.get(name);
			expect(fn?.metadata?.discovery).toBe(true);
			expect(fn?.metadata?.tags).toContain("discovery");
		}
		// Every discovery function must also be readonly (no write is discovery).
		for (const name of DISCOVERY_FUNCTIONS) {
			expect(
				READONLY_FUNCTIONS.includes(
					name as (typeof READONLY_FUNCTIONS)[number],
				),
			).toBe(true);
		}
		const discoveryFlagged = (mod.safeFunctions ?? []).filter(
			(f) => f.metadata?.discovery === true,
		);
		expect(discoveryFlagged.length).toBe(DISCOVERY_FUNCTIONS.length);
		// getMessageAttachment is readonly but NOT discovery — guard the boundary.
		expect(byName.get("getMessageAttachment")?.metadata?.discovery).not.toBe(
			true,
		);
	});

	// ── gmail owns its OWN BYO callback (does NOT reuse google-sheets') ────
	// gmail MUST register an authProvider and a /callback endpoint. Asserting
	// presence here guards against accidentally demoting it to functions-only.
	it("registers an authProvider (owns its own BYO connect flow)", async () => {
		const mod = await loadPlugin();
		expect(mod.authProvider).toBeDefined();
		expect(mod.authProvider?.type).toBe("oauth2");
	});

	it("authProvider exposes the BYO connect surface", async () => {
		const mod = await loadPlugin();
		const ap = mod.authProvider;
		expect(typeof ap?.initiate).toBe("function");
		expect(typeof ap?.handleCallback).toBe("function");
		expect(typeof ap?.configure).toBe("function");
		// authSetup is the CLI (terminal paste-the-code) connect path.
		expect(typeof ap?.authSetup).toBe("function");
	});

	// gmail is BYO-ONLY — it MUST NOT expose isFirstPartyAvailable. The
	// restricted scope cannot be satisfied by the relay-held first-party
	// client. Asserting the ABSENCE guards against accidentally copying the
	// google-sheets first-party surface into gmail.
	it("authProvider does NOT expose isFirstPartyAvailable (BYO only)", async () => {
		const mod = await loadPlugin();
		const ap = mod.authProvider;
		expect(ap?.isFirstPartyAvailable).toBeUndefined();
	});

	it("registers exactly one httpEndpoint: GET /callback", async () => {
		const mod = await loadPlugin();
		const eps = mod.httpEndpoints ?? [];
		expect(eps.length).toBe(1);
		expect(eps[0].method).toBe("GET");
		expect(eps[0].path).toBe("/callback");
		expect(typeof eps[0].handler).toBe("function");
	});

	it("has no config (no Zod schema, no tenant_config)", async () => {
		const mod = await loadPlugin();
		expect(mod.config).toBeUndefined();
	});

	it("onLoad tolerates a missing google-oauth credential (warns, no throw)", async () => {
		const mod = await loadPlugin();
		await expect(mod.onLoad?.(noopCtx)).resolves.toBeUndefined();
	});
});
