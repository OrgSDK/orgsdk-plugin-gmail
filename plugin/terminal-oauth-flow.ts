import fs from "node:fs/promises";
import { createInterface } from "node:readline";
import type { CredentialStore } from "@orgsdk/plugins";
import { OAuth2Client } from "google-auth-library";

// https://mail.google.com/ is a restricted scope (broad Gmail access). The
// gmail plugin is BYO-only — the tenant must register their own Google OAuth
// client and complete the restricted-scope consent/CASA process.
const GMAIL_SCOPE = "https://mail.google.com/";

type GoogleOAuthClientFile = {
	installed?: {
		client_id?: string;
		client_secret?: string;
		redirect_uris?: string[];
	};
	web?: {
		client_id?: string;
		client_secret?: string;
		redirect_uris?: string[];
	};
};

export interface GmailOAuthFlowOptions {
	/** CredentialStore used to persist the resulting refresh token. */
	store: CredentialStore;
	/** Path to the OAuth client JSON downloaded from Google Cloud Console. */
	credentialsPath: string;
	/** Credential name (e.g., "default", "work"). */
	name?: string;
	/** Human-readable label. */
	label?: string;
	/** Override redirect URI. */
	redirectUri?: string;
}

export interface GmailOAuthFlowResult {
	success: boolean;
	provider: "google-oauth";
	name: string;
	label: string;
	error?: string;
}

async function readOAuthClientFile(credentialsPath: string) {
	const raw = await fs.readFile(credentialsPath, "utf-8");
	const json = JSON.parse(raw) as GoogleOAuthClientFile;
	const src = json.installed ?? json.web;
	if (!src) {
		throw new Error(
			"OAuth client JSON must contain either an 'installed' or 'web' object",
		);
	}
	const clientId = src.client_id;
	const clientSecret = src.client_secret;
	const redirectUris = src.redirect_uris ?? [];
	if (!clientId || !clientSecret) {
		throw new Error("OAuth client JSON missing client_id or client_secret");
	}
	return { clientId, clientSecret, redirectUris };
}

async function promptLine(question: string): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	return await new Promise((resolve) => {
		rl.question(question, (answer) => {
			rl.close();
			resolve(answer);
		});
	});
}

/** Extract the authorization code from a pasted code, URL, or query string. */
function extractCode(input: string): string {
	const trimmed = input.trim();
	try {
		const url = new URL(trimmed);
		const code = url.searchParams.get("code");
		if (code) return code;
	} catch {
		// not a URL
	}
	if (trimmed.includes("code=")) {
		const match = trimmed.match(/(?:^|[?&])code=([^&]+)/);
		if (match?.[1]) return decodeURIComponent(match[1]);
	}
	return trimmed;
}

export async function runGmailOAuthFlow(
	options: GmailOAuthFlowOptions,
): Promise<GmailOAuthFlowResult> {
	const name = options.name ?? "default";
	const label = options.label ?? `Gmail OAuth (${name})`;

	const { clientId, clientSecret, redirectUris } = await readOAuthClientFile(
		options.credentialsPath,
	);
	const redirectUri = options.redirectUri ?? redirectUris[0];

	if (!redirectUri) {
		return {
			success: false,
			provider: "google-oauth",
			name,
			label,
			error:
				"No redirect URI found. Pass --redirect-uri or add redirect_uris to the OAuth client JSON.",
		};
	}

	const oauth = new OAuth2Client({ clientId, clientSecret, redirectUri });
	const authUrl = oauth.generateAuthUrl({
		access_type: "offline",
		prompt: "consent",
		scope: [GMAIL_SCOPE],
	});

	console.log("Open this URL in your browser:\n");
	console.log(`${authUrl}\n`);
	console.log(
		"After approving, copy the 'code' param from the redirected URL (or paste the whole URL).\n",
	);

	const raw = await promptLine("Paste code or redirected URL: ");
	const code = extractCode(raw);
	if (!code) {
		return {
			success: false,
			provider: "google-oauth",
			name,
			label,
			error: "No code provided",
		};
	}

	let refreshToken: string;
	try {
		const { tokens } = await oauth.getToken(code);
		if (!tokens.refresh_token) {
			return {
				success: false,
				provider: "google-oauth",
				name,
				label,
				error:
					"Google did not return a refresh_token. This usually means the client was already authorized. " +
					"Revoke access at https://myaccount.google.com/permissions and retry.",
			};
		}
		refreshToken = tokens.refresh_token;
	} catch (err) {
		return {
			success: false,
			provider: "google-oauth",
			name,
			label,
			error: `Token exchange failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	await options.store.setSecrets(
		"google-oauth-client",
		"default",
		{ secret_clientId: clientId, secret_clientSecret: clientSecret },
		{ label: "Google OAuth client (default)", valid: true },
	);

	await options.store.setSecrets(
		"google-oauth",
		name,
		{
			secret_clientId: clientId,
			secret_clientSecret: clientSecret,
			secret_refreshToken: refreshToken,
			source: "byo",
			createdAt: new Date().toISOString(),
		},
		{ label, valid: true },
	);

	return { success: true, provider: "google-oauth", name, label };
}
