import type {
	PluginContext,
	PluginFactory,
	PluginModule,
} from "@orgsdk/plugins";
import { GmailOAuthProvider } from "./auth-provider";
import { safeFunctions as gmailFns } from "./gmail-functions";

const createPlugin: PluginFactory = (ctx: PluginContext): PluginModule => {
	const authProvider = new GmailOAuthProvider(ctx);
	return {
		safeFunctions: gmailFns,
		httpEndpoints: authProvider.getHttpEndpoints(),
		authProvider,
		async onLoad() {
			const cred = await ctx.stores.credential.get("google-oauth", "default");
			if (!cred) {
				ctx.logger.warn(
					"[gmail] No google-oauth credential found. Connect Google (BYO client) in the dashboard (Credentials tab).",
				);
			}
		},
	};
};

export default createPlugin;
