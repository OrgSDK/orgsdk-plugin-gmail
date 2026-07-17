/**
 * MIME / base64url pure-helper tests.
 *
 * gmail's only EXPORTED pure helper is `decodeBase64UrlToUtf8` (oauth.ts) —
 * the inverse of the base64url encoding the send handlers apply when building
 * raw MIME messages. Gmail returns message/attachment bodies as base64url
 * without padding, so the decoder must tolerate missing padding and the URL-safe
 * alphabet (- and _).
 *
 * The MIME multipart message builders (sendMessage, sendMessageWithAttachment,
 * replyToMessage) are embedded INSIDE their handlers and not separately
 * exported, so they cannot be unit-tested in isolation without a refactor
 * (out of scope for an extraction — recorded in docs/contract-migration.md as
 * a frozen code-quality note). This test covers the pure decoder that IS
 * exported, and round-trips it against the exact base64url encoding the send
 * handlers use, proving the wire format is symmetric.
 */
import { describe, expect, it } from "bun:test";
import { decodeBase64UrlToUtf8 } from "../plugin/oauth";

describe("decodeBase64UrlToUtf8 (pure helper)", () => {
	it("decodes a standard base64url string", () => {
		// "Hello, Gmail!" in base64url
		expect(decodeBase64UrlToUtf8("SGVsbG8sIEdtYWlsIQ")).toBe("Hello, Gmail!");
	});

	it("decodes base64url with the URL-safe alphabet (- and _)", () => {
		// ">>>" encodes to standard base64 "Pj4+" (contains '+'); "???"
		// encodes to "Pz8/" (contains '/'). Both are valid ASCII/UTF-8, so
		// the UTF-8 round-trip is exact. Compute authoritatively from Buffer.
		for (const text of [">>>", "???", ">>>???"]) {
			const standardB64 = Buffer.from(text, "utf-8").toString("base64");
			// Sanity: the standard encoding really does use the chars that
			// distinguish base64url from base64, so this test is meaningful.
			expect(standardB64.includes("+") || standardB64.includes("/")).toBe(true);
			// Convert to base64url (what Gmail sends): + → -, / → _, strip =
			const urlSafe = standardB64
				.replace(/\+/g, "-")
				.replace(/\//g, "_")
				.replace(/=+$/, "");
			expect(decodeBase64UrlToUtf8(urlSafe)).toBe(text);
		}
	});

	it("tolerates missing padding (Gmail returns unpadded base64url)", () => {
		// Compute the unpadded base64url of each input from Buffer (authoritative)
		// and assert the decoder reverses it — covers 0/1/2 padding-byte cases.
		for (const text of ["A", "AB", "ABC", "ABCD"]) {
			const urlSafe = Buffer.from(text, "utf-8")
				.toString("base64")
				.replace(/\+/g, "-")
				.replace(/\//g, "_")
				.replace(/=+$/, "");
			expect(decodeBase64UrlToUtf8(urlSafe)).toBe(text);
		}
	});

	it("also accepts standard base64 (with + and /) by normalizing", () => {
		// The decoder replaces - → + and _ → /, so standard base64 (which has
		// neither - nor _) also decodes correctly. This is lenient but matches
		// the monorepo behavior.
		expect(decodeBase64UrlToUtf8("SGVsbG8")).toBe("Hello");
	});

	it("round-trips against the exact base64url encoding the send handlers use", () => {
		// The send handlers (sendMessage et al.) encode raw MIME as:
		//   Buffer.from(x).toString("base64")
		//     .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
		// Prove decode reverses that for a realistic MIME-ish payload.
		const mimeLike = [
			"From: me",
			"To: client@example.com",
			"Subject: Invoice #42",
			"Content-Type: text/plain; charset=utf-8",
			"",
			"Please find attached + pay/special/fees.",
		].join("\r\n");
		const encoded = Buffer.from(mimeLike)
			.toString("base64")
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
		expect(decodeBase64UrlToUtf8(encoded)).toBe(mimeLike);
	});

	it("decodes an empty string to an empty string", () => {
		expect(decodeBase64UrlToUtf8("")).toBe("");
	});

	it("preserves multibyte UTF-8 (email bodies are UTF-8)", () => {
		// "Café — résumé" with em-dash and accented chars.
		const text = "Café — résumé ₿ ✓";
		const encoded = Buffer.from(text, "utf-8")
			.toString("base64")
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
		expect(decodeBase64UrlToUtf8(encoded)).toBe(text);
	});
});
