import { OAuth2Client } from "google-auth-library";

export interface GoogleOAuthBundle {
	secret_clientId?: string;
	secret_clientSecret?: string;
	secret_refreshToken?: string;
	/** Discriminator set at connect time. Absent = legacy (treated as byo). */
	source?: "first-party" | "byo";
	[key: string]: unknown;
}

/**
 * Build an OAuth2Client from a stored credential bundle.
 *
 * Gmail is a restricted scope (CASA audit) so the gmail plugin is BYO-only —
 * the tenant's own client secret refreshes locally. If the credential was
 * issued via first-party by the `google` (sheets/tasks) plugin, it carries no
 * client secret and lacks the Gmail scope, so we refuse it with a clear error
 * rather than failing opaquely inside the Gmail API call.
 */
export async function getGoogleOAuth2Client(
	bundle: GoogleOAuthBundle,
): Promise<OAuth2Client> {
	if (bundle.source === "first-party") {
		throw new Error(
			"This google-oauth token was issued via first-party (Sheets/Tasks only) and cannot access Gmail. " +
				"Gmail is a restricted scope — connect your own Google OAuth client for the gmail plugin.",
		);
	}

	const { secret_clientId, secret_clientSecret, secret_refreshToken } = bundle;
	if (!secret_refreshToken) {
		throw new Error(
			"Missing google-oauth refresh token. Connect Google (BYO client) in the dashboard (Credentials tab).",
		);
	}
	const client = new OAuth2Client({
		clientId: secret_clientId,
		clientSecret: secret_clientSecret,
	});
	client.setCredentials({ refresh_token: secret_refreshToken });
	return client;
}

export function decodeBase64UrlToUtf8(encoded: string): string {
	const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
	const paddingLen = (4 - (base64.length % 4)) % 4;
	const padded = base64 + "=".repeat(paddingLen);
	return Buffer.from(padded, "base64").toString("utf-8");
}
