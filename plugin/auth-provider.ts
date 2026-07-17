import type {
	AuthMeta,
	AuthProvider,
	HttpEndpoint,
	PluginContext,
} from "@orgsdk/plugins";
import { OAuth2Client } from "google-auth-library";
import { runGmailOAuthFlow } from "./terminal-oauth-flow";

const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Gmail is a restricted scope requiring a CASA security assessment, so it
 * cannot use the relay's first-party OAuth (see docs/plan-first-party-oauth.md
 * §6). Tenants must supply their own Google OAuth client; the client secret is
 * used locally to exchange the auth code and to refresh tokens.
 */
const GMAIL_SCOPE = "https://mail.google.com/";

interface PendingState {
	credentialName: string;
	createdAt: number;
	clientId: string;
	clientSecret: string;
	redirectUri: string;
}

type GoogleOAuthClientFile = {
	installed?: { client_id?: string; client_secret?: string };
	web?: { client_id?: string; client_secret?: string };
};

/**
 * BYO-only OAuth provider for Gmail.
 *
 * Credential resolution mirrors the `google` plugin's BYO tiers (so one client
 * configured under `google-oauth-client/default` serves both plugins), but
 * omits the first-party relay tier entirely.
 */
export class GmailOAuthProvider implements AuthProvider {
	readonly type = "oauth2" as const;
	readonly authMeta: AuthMeta = {
		displayName: "Gmail",
		configField: {
			label: "Google OAuth client JSON (Web application, Gmail scope)",
			placeholder:
				'{"web": {"client_id": "...", "client_secret": "...", "redirect_uris": ["https://.../plugins/gmail/callback"]}}',
		},
	};

	constructor(private readonly ctx: PluginContext) {}

	async initiate(
		credentialName: string,
	): Promise<{ authUrl: string; state: string }> {
		const byo = await this.resolveByoClient(credentialName);
		if (!byo) {
			throw new Error(
				"Gmail requires your own Google OAuth client (restricted scope). " +
					`Checked google-oauth-client/default, google-oauth-client/${credentialName}, google-oauth/${credentialName}. ` +
					"Paste your OAuth client JSON (grants https://mail.google.com/) in the Credentials tab.",
			);
		}

		const oauth = new OAuth2Client({
			clientId: byo.clientId,
			clientSecret: byo.clientSecret,
			redirectUri: byo.redirectUri,
		});

		const state = crypto.randomUUID();
		this.cleanExpiredStates();
		this.pendingStates.set(state, {
			credentialName,
			createdAt: Date.now(),
			clientId: byo.clientId,
			clientSecret: byo.clientSecret,
			redirectUri: byo.redirectUri,
		});

		const authUrl = oauth.generateAuthUrl({
			access_type: "offline",
			prompt: "consent",
			scope: [GMAIL_SCOPE],
			state,
		});

		return { authUrl, state };
	}

	async handleCallback(
		req: Request,
	): Promise<{ success: boolean; credentialName: string; error?: string }> {
		const url = new URL(req.url);
		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state");

		if (!state || !code) {
			return {
				success: false,
				credentialName: "",
				error: "Missing code or state parameter",
			};
		}

		const pending = this.pendingStates.get(state);
		if (!pending) {
			return {
				success: false,
				credentialName: "",
				error: "Invalid or expired state",
			};
		}

		if (Date.now() - pending.createdAt > STATE_TTL_MS) {
			this.pendingStates.delete(state);
			return { success: false, credentialName: "", error: "State expired" };
		}

		this.pendingStates.delete(state);

		try {
			const oauth = new OAuth2Client({
				clientId: pending.clientId,
				clientSecret: pending.clientSecret,
				redirectUri: pending.redirectUri,
			});
			const { tokens } = await oauth.getToken(code);
			const refreshToken = tokens.refresh_token;

			if (!refreshToken) {
				return {
					success: false,
					credentialName: pending.credentialName,
					error:
						"Google did not return a refresh_token. Revoke access at https://myaccount.google.com/permissions and retry.",
				};
			}

			await this.ctx.stores.credential.setSecrets(
				"google-oauth",
				pending.credentialName,
				{
					secret_clientId: pending.clientId,
					secret_clientSecret: pending.clientSecret,
					secret_refreshToken: refreshToken,
					source: "byo",
					createdAt: new Date().toISOString(),
				},
				{ label: `Gmail OAuth (${pending.credentialName})`, valid: true },
			);

			return { success: true, credentialName: pending.credentialName };
		} catch (err) {
			return {
				success: false,
				credentialName: pending.credentialName,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	getHttpEndpoints(): HttpEndpoint[] {
		return [
			{
				method: "GET",
				path: "/callback",
				handler: async (req) => {
					const result = await this.handleCallback(req);
					if (result.success) {
						return new Response(
							`<html><body><h2>Gmail OAuth success</h2><p>Credential '${result.credentialName}' saved. You can close this tab.</p></body></html>`,
							{ headers: { "Content-Type": "text/html" } },
						);
					}
					return new Response(
						`<html><body><h2>Gmail OAuth failed</h2><p>${result.error ?? "Unknown error"}</p></body></html>`,
						{ status: 400, headers: { "Content-Type": "text/html" } },
					);
				},
			},
		];
	}

	async configure(json: string, credentialName: string): Promise<void> {
		const parsed = JSON.parse(json) as GoogleOAuthClientFile;
		const src = parsed.installed ?? parsed.web;
		if (!src?.client_id || !src?.client_secret) {
			throw new Error(
				"JSON must contain an 'installed' or 'web' object with client_id and client_secret",
			);
		}
		await this.ctx.stores.credential.setSecrets(
			"google-oauth-client",
			credentialName,
			{
				secret_clientId: src.client_id,
				secret_clientSecret: src.client_secret,
			},
			{ label: `Google OAuth client (${credentialName})`, valid: true },
		);
	}

	async authSetup(
		options: Record<string, string>,
	): Promise<{ success: boolean; message?: string; error?: string }> {
		const result = await runGmailOAuthFlow({
			store: this.ctx.stores.credential,
			credentialsPath: options.credentials ?? "",
			name: options.name ?? "default",
			label: options.label,
			redirectUri: options.redirectUri,
		});
		return {
			success: result.success,
			message: result.success
				? `Saved credential '${result.provider}/${result.name}'.`
				: undefined,
			error: result.error,
		};
	}

	private readonly pendingStates = new Map<string, PendingState>();

	/**
	 * BYO client resolution (3 tiers, no first-party). Returns null when the
	 * tenant has not configured an OAuth client.
	 */
	private async resolveByoClient(credentialName: string): Promise<{
		clientId: string;
		clientSecret: string;
		redirectUri: string;
	} | null> {
		const redirectUri = `${this.ctx.publicBaseUrl}/plugins/gmail/callback`;
		const pairs: Array<[string, string]> = [
			["google-oauth-client", "default"],
			["google-oauth-client", credentialName],
			["google-oauth", credentialName],
		];
		for (const [provider, name] of pairs) {
			const secrets = await this.ctx.stores.credential.getSecrets(
				provider,
				name,
			);
			const clientId = secrets?.secret_clientId as string | undefined;
			const clientSecret = secrets?.secret_clientSecret as string | undefined;
			if (clientId && clientSecret) {
				return { clientId, clientSecret, redirectUri };
			}
		}
		return null;
	}

	private cleanExpiredStates() {
		const now = Date.now();
		for (const [k, v] of this.pendingStates) {
			if (now - v.createdAt > STATE_TTL_MS) this.pendingStates.delete(k);
		}
	}
}
