import type { SafeFunction } from "@orgsdk/plugins";
export const moduleDescription =
	"Send, receive, search, and manage Gmail messages, labels, and attachments";

import { gmail_v1, type gmail_v1 as gmailV1Namespace } from "@googleapis/gmail";
import TurndownService from "turndown";
import type { GoogleOAuthBundle } from "./oauth.ts";
import { decodeBase64UrlToUtf8, getGoogleOAuth2Client } from "./oauth.ts";

type GmailMessage = {
	id: string;
	threadId?: string;
	labelIds?: string[];
	internalDateMs?: number;
	snippet?: string;

	// Common headers (also duplicated into `headers` for convenience).
	from?: string;
	to?: string;
	date?: string;
	subject?: string;

	body: string;
	headers?: Record<string, string>;

	attachments?: GmailAttachmentRef[];
};

type GmailAttachmentRef = {
	filename: string;
	mimeType?: string;
	attachmentId: string;
	size?: number;
};

/**
 * Create a configured TurndownService optimized for email content.
 * Removes tracking pixels, hidden elements, and non-content elements.
 */
function createEmailTurndownService(): TurndownService {
	const td = new TurndownService({
		headingStyle: "atx",
		bulletListMarker: "-",
		codeBlockStyle: "fenced",
	});

	// Remove non-content elements
	td.remove(["script", "style", "head", "meta", "link", "noscript"]);

	// Remove tracking pixels and hidden images
	td.addRule("removeTrackingPixels", {
		filter: (node) => {
			if (node.nodeName !== "IMG") return false;
			const w = node.getAttribute("width");
			const h = node.getAttribute("height");
			const style = node.getAttribute("style") || "";
			return (
				((w === "1" || w === "0") && (h === "1" || h === "0")) ||
				/display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)
			);
		},
		replacement: () => "",
	});

	return td;
}

const turndown = createEmailTurndownService();

/**
 * Pre-clean HTML before turndown conversion.
 * Removes comments, style blocks, and script blocks.
 */
function cleanEmailHtml(html: string): string {
	return html
		.replace(/<!--[\s\S]*?-->/g, "") // Remove comments
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "") // Remove style blocks
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ""); // Remove scripts
}

/**
 * Post-process markdown to normalize whitespace and truncate quoted email chains.
 */
function cleanMarkdown(markdown: string): string {
	let cleaned = markdown
		.replace(/\n{3,}/g, "\n\n") // Collapse multiple blank lines
		.replace(/[ \t]+$/gm, "") // Remove trailing whitespace
		.trim();

	// Truncate quoted email chains (keeps only the first/main message)
	const quotePatterns = [
		/\n{2,}On .+wrote:\s*\n/i,
		/\n{2,}-{5,}\s*(?:Forwarded|Original)\s+message\s*-{5,}/i,
	];
	for (const pattern of quotePatterns) {
		const match = cleaned.match(pattern);
		if (match?.index !== undefined) {
			cleaned = cleaned.substring(0, match.index).trim();
			break;
		}
	}

	return cleaned;
}

function getGoogleOAuth(creds: Record<string, unknown>): GoogleOAuthBundle {
	return (creds["google-oauth"] as GoogleOAuthBundle | undefined) ?? {};
}

async function createGmailClient(
	credentials: Record<string, unknown>,
): Promise<gmail_v1.Gmail> {
	if (!credentials["google-oauth"]) {
		throw new Error(
			"Missing google-oauth credential. Create .secrets/google-oauth.json",
		);
	}

	const google = getGoogleOAuth(credentials);
	const auth = await getGoogleOAuth2Client(google);
	return new gmail_v1.Gmail({ auth });
}

function getHeader(
	headers: Array<gmailV1Namespace.Schema$MessagePartHeader> | undefined,
	name: string,
): string | undefined {
	const found = (headers ?? []).find(
		(h) => (h.name ?? "").toLowerCase() === name.toLowerCase(),
	);
	return found?.value ?? undefined;
}

function decodeBase64UrlToBuffer(data: string): Buffer {
	const base64 = data.replace(/-/g, "+").replace(/_/g, "/");

	// Gmail returns base64url without padding.
	const paddingLen = (4 - (base64.length % 4)) % 4;
	const padded = base64 + "=".repeat(paddingLen);

	return Buffer.from(padded, "base64");
}

function walkParts(
	part: gmailV1Namespace.Schema$MessagePart | undefined,
	visitor: (p: gmailV1Namespace.Schema$MessagePart) => void,
): void {
	if (!part) return;

	visitor(part);
	for (const child of part.parts ?? []) {
		walkParts(child, visitor);
	}
}

function extractFirstBodyByMimeType(
	part: gmailV1Namespace.Schema$MessagePart | undefined,
	mimeTypePrefix: string,
): string | undefined {
	if (!part) return undefined;

	// Some messages store body directly on the payload.
	const mimeType = part.mimeType ?? "";
	if (mimeType.startsWith(mimeTypePrefix) && part.body?.data) {
		if (mimeTypePrefix === "text/plain") {
			return decodeBase64UrlToUtf8(part.body.data);
		}

		return decodeBase64UrlToBuffer(part.body.data).toString("utf-8");
	}

	for (const child of part.parts ?? []) {
		const text = extractFirstBodyByMimeType(child, mimeTypePrefix);
		if (text && text.trim()) return text;
	}

	return undefined;
}

function collectAttachments(
	part: gmailV1Namespace.Schema$MessagePart | undefined,
): GmailAttachmentRef[] {
	const attachments: GmailAttachmentRef[] = [];

	walkParts(part, (p) => {
		const filename = (p.filename ?? "").trim();
		const attachmentId = p.body?.attachmentId;
		if (!filename || !attachmentId) return;

		attachments.push({
			filename,
			mimeType: p.mimeType ?? undefined,
			attachmentId,
			size: p.body?.size ?? undefined,
		});
	});

	return attachments;
}

async function getMessage(
	gmail: gmail_v1.Gmail,
	id: string,
): Promise<GmailMessage> {
	const msgResp = await gmail.users.messages.get({
		userId: "me",
		id,
		format: "full",
	});

	const payload = msgResp.data.payload;
	const headers = payload?.headers;

	const from = getHeader(headers, "From");
	const to = getHeader(headers, "To");
	const subject = getHeader(headers, "Subject");
	const date = getHeader(headers, "Date");

	const headersRecord: Record<string, string> = {};
	for (const h of headers ?? []) {
		const name = (h.name ?? "").trim();
		const value = (h.value ?? "").trim();
		if (!name || !value) continue;
		if (!(name in headersRecord)) {
			headersRecord[name] = value;
		}
	}

	const bodyText = extractFirstBodyByMimeType(payload, "text/plain");
	const bodyHtml = extractFirstBodyByMimeType(payload, "text/html");

	let body: string;
	if (bodyText) {
		// Clean plain text (normalize whitespace, truncate quotes)
		body = cleanMarkdown(bodyText);
	} else if (bodyHtml) {
		// Convert HTML to clean text via markdown
		const cleanedHtml = cleanEmailHtml(bodyHtml);
		const rawMarkdown = turndown.turndown(cleanedHtml);
		body = cleanMarkdown(rawMarkdown);
	} else {
		body = "No content";
	}

	const internalDateRaw = msgResp.data.internalDate;
	const internalDateMs =
		typeof internalDateRaw === "string" && internalDateRaw.trim()
			? Number(internalDateRaw)
			: undefined;

	return {
		id,
		threadId: msgResp.data.threadId ?? undefined,
		labelIds: msgResp.data.labelIds ?? undefined,
		internalDateMs: Number.isFinite(internalDateMs)
			? internalDateMs
			: undefined,
		snippet: msgResp.data.snippet ?? undefined,
		from,
		to,
		date,
		subject,
		body,
		headers: headersRecord,
		attachments: collectAttachments(payload),
	};
}

export const safeFunctions: SafeFunction[] = [
	{
		name: "getMessages",
		requiredCredentials: ["google-oauth"],
		handler: async (
			credentials: Record<string, unknown>,
			{ query, maxResults }: { query?: string; maxResults?: number },
		): Promise<GmailMessage[]> => {
			const gmail = await createGmailClient(credentials);

			const listResp = await gmail.users.messages.list({
				userId: "me",
				q: query,
				maxResults: maxResults ?? 10,
			});

			const messageIds: string[] = (listResp.data.messages ?? [])
				.map((m) => m.id)
				.filter((id): id is string => typeof id === "string");

			const results: GmailMessage[] = [];
			for (const id of messageIds) {
				results.push(await getMessage(gmail, id));
			}

			return results;
		},
		description:
			'Fetch Gmail messages using Gmail search query syntax (q). Label filters must use the label name (not the label ID), e.g. label:Expense or label:"Expense Reports". Returns cleaned text body optimized for LLM processing. HTML is converted to clean text, tracking pixels and quoted chains are removed.',
		returnType:
			"Promise<Array<{ id: string; threadId?: string; subject?: string; from?: string; date?: string; body: string; headers?: Record<string, string>; labelIds?: string[]; attachments?: Array<{ filename: string; mimeType?: string; attachmentId: string; size?: number }> }>>",
		parameters: [
			{ name: "query", type: "string" },
			{ name: "maxResults", type: "number" },
		],
		metadata: {
			category: "google",
			tags: ["readonly", "auth", "discovery"],
			readonly: true,
			discovery: true,
			version: "1.0.0",
			relatedTo: ["getMessage", "listLabels"],
		},
		docs: {
			summary:
				"Fetch Gmail messages using Gmail search query syntax. Returns cleaned text bodies optimized for LLM processing — HTML is converted to markdown, tracking pixels and quoted reply chains are removed.",
			parameters: [
				{
					name: "query",
					type: "string",
					description:
						"Gmail search query syntax. Label filters must use label name (not ID), e.g. label:Expense. Supports standard operators: from:, to:, subject:, after:, before:, is:unread, has:attachment.",
					example: '"label:Expense is:unread after:2026/01/01"',
					optional: true,
				},
				{
					name: "maxResults",
					type: "number",
					description: "Maximum number of messages to return.",
					defaultValue: "10",
					optional: true,
					example: "20",
				},
			],
			returns: {
				type: "Promise<GmailMessage[]>",
				description:
					"Array of message objects with id, subject, from, date, body (cleaned text), headers, labelIds, and attachments.",
				example:
					'[{ id: "18f...", subject: "Invoice #42", from: "vendor@example.com", body: "Please find attached...", attachments: [{ filename: "invoice.pdf", attachmentId: "ANGj..." }] }]',
			},
			examples: [
				{
					title: "Fetch recent unread emails",
					code: 'const msgs = await gmail.getMessages("is:unread", 5);\nmsgs.map(m => ({ subject: m.subject, from: m.from }));',
				},
				{
					title: "Search by label and date",
					code: 'const invoices = await gmail.getMessages("label:Invoices after:2026/01/01", 50);',
				},
				{
					title: "Filter with LLM classification",
					code: 'const msgs = await gmail.getMessages("label:inbox", 20);\nconst expenses = [];\nfor (const m of msgs) {\n  const isExpense = await llm.evalBoolean(\n    m.body,\n    "is an expense receipt or invoice",\n    { text: "Your payment of $50 was processed", matches: true },\n    { text: "Meeting tomorrow at 3pm", matches: false }\n  );\n  if (isExpense.result) expenses.push(m);\n}\nexpenses;',
					description: "Combine with llm.evalBoolean to classify emails",
				},
			],
			caveats: [
				"Use label names (not IDs) in query filters — e.g. label:Expense, not label:Label_13",
				"Messages are fetched sequentially; limit maxResults to 20-50 to stay within timeout",
				"Quoted reply chains are truncated — only the first/main message body is returned",
			],
			seeAlso: ["getMessage", "listLabels", "modifyMessageLabels"],
		},
	},
	{
		name: "getMessage",
		requiredCredentials: ["google-oauth"],
		handler: async (
			credentials: Record<string, unknown>,
			{ id }: { id: string },
		): Promise<GmailMessage> => {
			if (typeof id !== "string" || !id) {
				throw new Error("getMessage: id is required");
			}

			const gmail = await createGmailClient(credentials);
			return await getMessage(gmail, id);
		},
		description:
			"Fetch a single Gmail message by ID. Returns cleaned text body optimized for LLM processing. HTML is converted to clean text, tracking pixels and quoted chains are removed.",
		returnType:
			"Promise<{ id: string; threadId?: string; subject?: string; from?: string; date?: string; body: string; headers?: Record<string, string>; labelIds?: string[]; attachments?: Array<{ filename: string; mimeType?: string; attachmentId: string; size?: number }> }>",
		parameters: [{ name: "id", type: "string" }],
		metadata: {
			category: "google",
			tags: ["readonly", "auth", "discovery"],
			readonly: true,
			discovery: true,
			version: "1.0.0",
			relatedTo: ["getMessages", "getMessageAttachment"],
		},
	},
	{
		name: "listLabels",
		requiredCredentials: ["google-oauth"],
		handler: async (credentials: Record<string, unknown>) => {
			const gmail = await createGmailClient(credentials);
			const resp = await gmail.users.labels.list({ userId: "me" });
			return resp.data.labels ?? [];
		},
		description: "List Gmail labels (id + name)",
		returnType: "Promise<Array<{ id?: string; name?: string }>>",
		parameters: [],
		metadata: {
			category: "google",
			tags: ["readonly", "auth", "discovery"],
			readonly: true,
			discovery: true,
			version: "1.0.0",
			relatedTo: ["ensureLabel", "getMessages"],
		},
	},
	{
		name: "ensureLabel",
		requiredCredentials: ["google-oauth"],
		handler: async (
			credentials: Record<string, unknown>,
			{ name }: { name: string },
		) => {
			if (typeof name !== "string" || !name.trim()) {
				throw new Error("ensureLabel: name is required");
			}

			const gmail = await createGmailClient(credentials);
			const labels =
				(await gmail.users.labels.list({ userId: "me" })).data.labels ?? [];
			const existing = labels.find(
				(l) => (l.name ?? "").toLowerCase() === name.toLowerCase(),
			);
			if (existing?.id) {
				return existing;
			}

			const resp = await gmail.users.labels.create({
				userId: "me",
				requestBody: {
					name,
					labelListVisibility: "labelShow",
					messageListVisibility: "show",
				},
			});

			return resp.data;
		},
		description:
			"Get or create a Gmail label by name; returns label object (id + name)",
		returnType: "Promise<{ id?: string; name?: string }>",
		parameters: [{ name: "name", type: "string" }],
		metadata: {
			category: "google",
			tags: ["auth"],
			version: "1.0.0",
			relatedTo: ["listLabels", "modifyMessageLabels"],
		},
	},
	{
		name: "modifyMessageLabels",
		requiredCredentials: ["google-oauth"],
		handler: async (
			credentials: Record<string, unknown>,
			{
				messageId,
				addLabelIds = [],
				removeLabelIds = [],
			}: {
				messageId: string;
				addLabelIds?: string[];
				removeLabelIds?: string[];
			},
		) => {
			if (typeof messageId !== "string" || !messageId) {
				throw new Error("modifyMessageLabels: messageId is required");
			}

			const gmail = await createGmailClient(credentials);
			const resp = await gmail.users.messages.modify({
				userId: "me",
				id: messageId,
				requestBody: {
					addLabelIds,
					removeLabelIds,
				},
			});

			return {
				success: true,
				id: resp.data.id,
				labelIds: resp.data.labelIds ?? [],
			};
		},
		description:
			"Add/remove Gmail label IDs on a message. Use removeLabelIds:['UNREAD'] to mark as read.",
		returnType:
			"Promise<{ success: boolean; id?: string; labelIds: string[] }>",
		parameters: [
			{ name: "messageId", type: "string" },
			{ name: "addLabelIds", type: "string[]" },
			{ name: "removeLabelIds", type: "string[]" },
		],
		metadata: {
			category: "google",
			tags: ["auth"],
			version: "1.0.0",
			relatedTo: ["ensureLabel", "markMessageAsRead", "markMessageAsUnread"],
		},
	},
	{
		name: "batchModifyMessages",
		requiredCredentials: ["google-oauth"],
		handler: async (
			credentials: Record<string, unknown>,
			{
				messageIds,
				addLabelIds = [],
				removeLabelIds = [],
			}: {
				messageIds: string[];
				addLabelIds?: string[];
				removeLabelIds?: string[];
			},
		) => {
			if (!Array.isArray(messageIds) || messageIds.length === 0) {
				throw new Error("batchModifyMessages: messageIds[] is required");
			}

			const gmail = await createGmailClient(credentials);
			await gmail.users.messages.batchModify({
				userId: "me",
				requestBody: {
					ids: messageIds,
					addLabelIds,
					removeLabelIds,
				},
			});

			return { success: true, count: messageIds.length };
		},
		description: "Batch add/remove label IDs across multiple message IDs",
		returnType: "Promise<{ success: boolean; count: number }>",
		parameters: [
			{ name: "messageIds", type: "string[]" },
			{ name: "addLabelIds", type: "string[]" },
			{ name: "removeLabelIds", type: "string[]" },
		],
		metadata: {
			category: "google",
			tags: ["auth"],
			version: "1.0.0",
			relatedTo: ["modifyMessageLabels"],
		},
	},
	{
		name: "markMessageAsRead",
		requiredCredentials: ["google-oauth"],
		handler: async (
			credentials: Record<string, unknown>,
			{ messageId }: { messageId: string },
		) => {
			if (typeof messageId !== "string" || !messageId) {
				throw new Error("markMessageAsRead: messageId is required");
			}

			const gmail = await createGmailClient(credentials);
			const resp = await gmail.users.messages.modify({
				userId: "me",
				id: messageId,
				requestBody: {
					removeLabelIds: ["UNREAD"],
				},
			});

			return {
				success: true,
				id: resp.data.id,
				labelIds: resp.data.labelIds ?? [],
			};
		},
		description: "Mark Gmail message as read (removes UNREAD label)",
		returnType:
			"Promise<{ success: boolean; id?: string; labelIds: string[] }>",
		parameters: [{ name: "messageId", type: "string" }],
		metadata: {
			category: "google",
			tags: ["auth"],
			version: "1.0.0",
			relatedTo: ["modifyMessageLabels", "markMessageAsUnread"],
		},
	},
	{
		name: "markMessageAsUnread",
		requiredCredentials: ["google-oauth"],
		handler: async (
			credentials: Record<string, unknown>,
			{ messageId }: { messageId: string },
		) => {
			if (typeof messageId !== "string" || !messageId) {
				throw new Error("markMessageAsUnread: messageId is required");
			}

			const gmail = await createGmailClient(credentials);
			const resp = await gmail.users.messages.modify({
				userId: "me",
				id: messageId,
				requestBody: {
					addLabelIds: ["UNREAD"],
				},
			});

			return {
				success: true,
				id: resp.data.id,
				labelIds: resp.data.labelIds ?? [],
			};
		},
		description: "Mark Gmail message as unread (adds UNREAD label)",
		returnType:
			"Promise<{ success: boolean; id?: string; labelIds: string[] }>",
		parameters: [{ name: "messageId", type: "string" }],
		metadata: {
			category: "google",
			tags: ["auth"],
			version: "1.0.0",
			relatedTo: ["modifyMessageLabels", "markMessageAsRead"],
		},
	},
	{
		name: "sendMessage",
		requiredCredentials: ["google-oauth"],
		handler: async (
			credentials: Record<string, unknown>,
			{
				to,
				subject,
				body,
				html,
				cc,
				bcc,
			}: {
				to: string;
				subject: string;
				body: string;
				html?: string;
				cc?: string;
				bcc?: string;
			},
		): Promise<{ success: boolean; id: string; threadId?: string }> => {
			if (typeof to !== "string" || !to.trim()) {
				throw new Error("sendMessage: to is required");
			}
			if (typeof subject !== "string") {
				throw new Error("sendMessage: subject is required");
			}
			if (typeof body !== "string") {
				throw new Error("sendMessage: body is required");
			}

			const lines: string[] = ["From: me", `To: ${to}`];
			if (cc) lines.push(`Cc: ${cc}`);
			if (bcc) lines.push(`Bcc: ${bcc}`);
			lines.push(`Subject: ${subject}`);

			if (html) {
				const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;
				lines.push(
					"MIME-Version: 1.0",
					`Content-Type: multipart/alternative; boundary="${boundary}"`,
					"",
					`--${boundary}`,
					"Content-Type: text/plain; charset=utf-8",
					"",
					body,
					`--${boundary}`,
					"Content-Type: text/html; charset=utf-8",
					"",
					html,
					`--${boundary}--`,
				);
			} else {
				lines.push("Content-Type: text/plain; charset=utf-8", "", body);
			}

			const raw = Buffer.from(lines.join("\r\n"))
				.toString("base64")
				.replace(/\+/g, "-")
				.replace(/\//g, "_")
				.replace(/=+$/, "");

			const gmail = await createGmailClient(credentials);
			const resp = await gmail.users.messages.send({
				userId: "me",
				requestBody: { raw },
			});

			return {
				success: true,
				id: resp.data.id!,
				threadId: resp.data.threadId ?? undefined,
			};
		},
		description:
			"Send an email via Gmail. Supports plain-text or HTML body. When html is provided, sends a multipart/alternative message with both text/plain and text/html parts.",
		returnType: "Promise<{ success: boolean; id: string; threadId?: string }>",
		parameters: [
			{ name: "to", type: "string" },
			{ name: "subject", type: "string" },
			{ name: "body", type: "string" },
			{ name: "html", type: "string" },
			{ name: "cc", type: "string" },
			{ name: "bcc", type: "string" },
		],
		metadata: {
			category: "google",
			tags: ["auth"],
			version: "1.1.0",
			relatedTo: ["getMessages", "replyToMessage", "sendMessageWithAttachment"],
		},
	},
	{
		name: "sendMessageWithAttachment",
		requiredCredentials: ["google-oauth"],
		handler: async (
			credentials: Record<string, unknown>,
			{
				to,
				subject,
				body,
				html,
				attachments,
				cc,
				bcc,
			}: {
				to: string;
				subject: string;
				body: string;
				html?: string;
				attachments: Array<{
					filename: string;
					mimeType: string;
					base64Data: string;
				}>;
				cc?: string;
				bcc?: string;
			},
		): Promise<{ success: boolean; id: string; threadId?: string }> => {
			if (typeof to !== "string" || !to.trim()) {
				throw new Error("sendMessageWithAttachment: to is required");
			}
			if (typeof subject !== "string") {
				throw new Error("sendMessageWithAttachment: subject is required");
			}
			if (typeof body !== "string") {
				throw new Error("sendMessageWithAttachment: body is required");
			}
			if (!Array.isArray(attachments) || attachments.length === 0) {
				throw new Error(
					"sendMessageWithAttachment: at least one attachment is required",
				);
			}

			const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;

			const altBoundary = `alt_${Date.now()}_${Math.random().toString(36).slice(2)}`;

			const headerLines: string[] = ["From: me", `To: ${to}`];
			if (cc) headerLines.push(`Cc: ${cc}`);
			if (bcc) headerLines.push(`Bcc: ${bcc}`);
			headerLines.push(
				`Subject: ${subject}`,
				"MIME-Version: 1.0",
				`Content-Type: multipart/mixed; boundary="${boundary}"`,
				"",
				`--${boundary}`,
			);

			if (html) {
				headerLines.push(
					`Content-Type: multipart/alternative; boundary="${altBoundary}"`,
					"",
					`--${altBoundary}`,
					"Content-Type: text/plain; charset=utf-8",
					"",
					body,
					`--${altBoundary}`,
					"Content-Type: text/html; charset=utf-8",
					"",
					html,
					`--${altBoundary}--`,
				);
			} else {
				headerLines.push("Content-Type: text/plain; charset=utf-8", "", body);
			}

			for (const att of attachments) {
				if (!att.filename || !att.mimeType || !att.base64Data) {
					throw new Error(
						"sendMessageWithAttachment: each attachment needs filename, mimeType, and base64Data",
					);
				}
				headerLines.push(
					`--${boundary}`,
					`Content-Type: ${att.mimeType}`,
					`Content-Disposition: attachment; filename="${att.filename}"`,
					"Content-Transfer-Encoding: base64",
					"",
					att.base64Data,
				);
			}

			headerLines.push(`--${boundary}--`);

			const raw = Buffer.from(headerLines.join("\r\n"))
				.toString("base64")
				.replace(/\+/g, "-")
				.replace(/\//g, "_")
				.replace(/=+$/, "");

			const gmail = await createGmailClient(credentials);
			const resp = await gmail.users.messages.send({
				userId: "me",
				requestBody: { raw },
			});

			return {
				success: true,
				id: resp.data.id!,
				threadId: resp.data.threadId ?? undefined,
			};
		},
		description:
			"Send an email with file attachments via Gmail. Builds a MIME multipart/mixed message with a plain-text or HTML body and one or more base64-encoded attachments. When html is provided, the body is nested in multipart/alternative.",
		returnType: "Promise<{ success: boolean; id: string; threadId?: string }>",
		parameters: [
			{ name: "to", type: "string" },
			{ name: "subject", type: "string" },
			{ name: "body", type: "string" },
			{ name: "html", type: "string" },
			{
				name: "attachments",
				type: "Array<{ filename: string; mimeType: string; base64Data: string }>",
			},
			{ name: "cc", type: "string" },
			{ name: "bcc", type: "string" },
		],
		metadata: {
			category: "google",
			tags: ["auth"],
			version: "1.1.0",
			relatedTo: ["sendMessage", "generatePdf"],
		},
		docs: {
			summary:
				"Send an email with file attachments via Gmail. Constructs a MIME multipart/mixed message with a text body and base64-encoded attachment parts. Useful for sending generated PDFs, reports, or other files.",
			parameters: [
				{
					name: "to",
					type: "string",
					description: "Recipient email address",
					example: '"client@example.com"',
				},
				{
					name: "subject",
					type: "string",
					description: "Email subject line",
					example: '"Invoice #1001"',
				},
				{
					name: "body",
					type: "string",
					description:
						"Plain-text email body (fallback for clients that don't support HTML)",
					example: '"Please find your invoice attached."',
				},
				{
					name: "html",
					type: "string",
					description:
						"Optional HTML email body. When provided, sends multipart/alternative with both plain text and HTML.",
					optional: true,
				},
				{
					name: "attachments",
					type: "Array<{ filename: string; mimeType: string; base64Data: string }>",
					description:
						"Array of attachments. Each needs a filename, MIME type, and base64-encoded data.",
					example:
						'[{ filename: "invoice.pdf", mimeType: "application/pdf", base64Data: "JVBERi0xLjQK..." }]',
				},
				{
					name: "cc",
					type: "string",
					description: "CC recipients (optional)",
				},
				{
					name: "bcc",
					type: "string",
					description: "BCC recipients (optional)",
				},
			],
			returns: {
				type: "Promise<{ success: boolean; id: string; threadId?: string }>",
				description:
					"Confirmation with the sent message ID and optional thread ID.",
				example: '{ success: true, id: "18e3a...", threadId: "18e3a..." }',
			},
			examples: [
				{
					title: "Generate a PDF and email it",
					code: `const pdf = await browser.generatePdf("<html><body><h1>Invoice</h1></body></html>", { filename: "invoice.pdf" });
await gmail.sendMessageWithAttachment(
  "client@example.com",
  "Your Invoice",
  "Please find your invoice attached.",
  [{ filename: pdf.filename, mimeType: "application/pdf", base64Data: pdf.base64 }]
);`,
					description:
						"Generate a PDF invoice and send it as an email attachment",
				},
			],
			seeAlso: [
				"gmail.sendMessage",
				"browser.generatePdf",
				"gmail.replyToMessage",
			],
		},
	},
	{
		name: "replyToMessage",
		requiredCredentials: ["google-oauth"],
		handler: async (
			credentials: Record<string, unknown>,
			{
				messageId,
				body,
				html,
				cc,
				bcc,
			}: {
				messageId: string;
				body: string;
				html?: string;
				cc?: string;
				bcc?: string;
			},
		): Promise<{ success: boolean; id: string; threadId?: string }> => {
			if (typeof messageId !== "string" || !messageId.trim()) {
				throw new Error("replyToMessage: messageId is required");
			}
			if (typeof body !== "string") {
				throw new Error("replyToMessage: body is required");
			}

			const gmail = await createGmailClient(credentials);

			// Fetch original message for threading headers
			const original = await gmail.users.messages.get({
				userId: "me",
				id: messageId,
				format: "metadata",
				metadataHeaders: ["Message-ID", "Subject", "From", "To", "Cc"],
			});

			const origHeaders = original.data.payload?.headers ?? [];
			const getOrigHeader = (name: string) =>
				origHeaders.find(
					(h) => (h.name ?? "").toLowerCase() === name.toLowerCase(),
				)?.value ?? "";

			const origMessageId = getOrigHeader("Message-ID");
			const origSubject = getOrigHeader("Subject");
			const origFrom = getOrigHeader("From");
			const threadId = original.data.threadId ?? undefined;

			// Reply goes to the original sender
			const to = origFrom;
			if (!to) {
				throw new Error(
					"replyToMessage: could not determine reply recipient from original message",
				);
			}

			// Prefix subject with Re: if not already present
			const subject = /^re:/i.test(origSubject)
				? origSubject
				: `Re: ${origSubject}`;

			const lines: string[] = ["From: me", `To: ${to}`];
			if (cc) lines.push(`Cc: ${cc}`);
			if (bcc) lines.push(`Bcc: ${bcc}`);
			if (origMessageId) {
				lines.push(`In-Reply-To: ${origMessageId}`);
				lines.push(`References: ${origMessageId}`);
			}
			lines.push(`Subject: ${subject}`);

			if (html) {
				const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;
				lines.push(
					"MIME-Version: 1.0",
					`Content-Type: multipart/alternative; boundary="${boundary}"`,
					"",
					`--${boundary}`,
					"Content-Type: text/plain; charset=utf-8",
					"",
					body,
					`--${boundary}`,
					"Content-Type: text/html; charset=utf-8",
					"",
					html,
					`--${boundary}--`,
				);
			} else {
				lines.push("Content-Type: text/plain; charset=utf-8", "", body);
			}

			const raw = Buffer.from(lines.join("\r\n"))
				.toString("base64")
				.replace(/\+/g, "-")
				.replace(/\//g, "_")
				.replace(/=+$/, "");

			const resp = await gmail.users.messages.send({
				userId: "me",
				requestBody: { raw, threadId },
			});

			return {
				success: true,
				id: resp.data.id!,
				threadId: resp.data.threadId ?? undefined,
			};
		},
		description:
			"Reply to a Gmail message within its thread. Fetches the original message to set threading headers (In-Reply-To, References) and replies to the original sender. Supports HTML via multipart/alternative when html parameter is provided.",
		returnType: "Promise<{ success: boolean; id: string; threadId?: string }>",
		parameters: [
			{ name: "messageId", type: "string" },
			{ name: "body", type: "string" },
			{ name: "html", type: "string" },
			{ name: "cc", type: "string" },
			{ name: "bcc", type: "string" },
		],
		metadata: {
			category: "google",
			tags: ["auth"],
			version: "1.1.0",
			relatedTo: ["sendMessage", "getMessage"],
		},
	},
	{
		name: "getMessageAttachment",
		requiredCredentials: ["google-oauth"],
		handler: async (
			credentials: Record<string, unknown>,
			{ messageId, attachmentId }: { messageId: string; attachmentId: string },
		) => {
			if (typeof messageId !== "string" || !messageId) {
				throw new Error("getMessageAttachment: messageId is required");
			}
			if (typeof attachmentId !== "string" || !attachmentId) {
				throw new Error("getMessageAttachment: attachmentId is required");
			}

			const gmail = await createGmailClient(credentials);
			const resp = await gmail.users.messages.attachments.get({
				userId: "me",
				messageId,
				id: attachmentId,
			});

			const dataUrl = resp.data.data ?? "";
			const buf = dataUrl ? decodeBase64UrlToBuffer(dataUrl) : Buffer.from("");

			return {
				messageId,
				attachmentId,
				size: resp.data.size ?? buf.byteLength,
				dataBase64: buf.toString("base64"),
			};
		},
		description:
			"Fetch a Gmail attachment by messageId + attachmentId. Returns standard base64 bytes (dataBase64).",
		returnType:
			"Promise<{ messageId: string; attachmentId: string; size?: number; dataBase64: string }>",
		parameters: [
			{ name: "messageId", type: "string" },
			{ name: "attachmentId", type: "string" },
		],
		metadata: {
			category: "google",
			tags: ["readonly", "auth"],
			readonly: true,
			version: "1.0.0",
			relatedTo: ["getMessage", "parsePdf"],
		},
	},
	{
		name: "getThread",
		requiredCredentials: ["google-oauth"],
		handler: async (
			credentials: Record<string, unknown>,
			{ threadId }: { threadId: string },
		): Promise<GmailMessage[]> => {
			if (typeof threadId !== "string" || !threadId) {
				throw new Error("getThread: threadId is required");
			}

			const gmail = await createGmailClient(credentials);
			const resp = await gmail.users.threads.get({
				userId: "me",
				id: threadId,
				format: "full",
			});

			const messages = resp.data.messages ?? [];
			const results: GmailMessage[] = [];
			for (const msg of messages) {
				if (!msg.id) continue;
				const payload = msg.payload;
				const headers = payload?.headers;

				const headersRecord: Record<string, string> = {};
				for (const h of headers ?? []) {
					const name = (h.name ?? "").trim();
					const value = (h.value ?? "").trim();
					if (name && value && !(name in headersRecord))
						headersRecord[name] = value;
				}

				const bodyText = extractFirstBodyByMimeType(payload, "text/plain");
				const bodyHtml = extractFirstBodyByMimeType(payload, "text/html");

				let body: string;
				if (bodyText) {
					// For thread messages keep quoted chains so context is preserved
					body = bodyText
						.replace(/\n{3,}/g, "\n\n")
						.replace(/[ \t]+$/gm, "")
						.trim();
				} else if (bodyHtml) {
					const cleanedHtml = cleanEmailHtml(bodyHtml);
					body = turndown
						.turndown(cleanedHtml)
						.replace(/\n{3,}/g, "\n\n")
						.replace(/[ \t]+$/gm, "")
						.trim();
				} else {
					body = "No content";
				}

				const internalDateRaw = msg.internalDate;
				const internalDateMs =
					typeof internalDateRaw === "string" && internalDateRaw.trim()
						? Number(internalDateRaw)
						: undefined;

				results.push({
					id: msg.id,
					threadId: msg.threadId ?? undefined,
					labelIds: msg.labelIds ?? undefined,
					internalDateMs: Number.isFinite(internalDateMs)
						? internalDateMs
						: undefined,
					snippet: msg.snippet ?? undefined,
					from: getHeader(headers, "From"),
					to: getHeader(headers, "To"),
					date: getHeader(headers, "Date"),
					subject: getHeader(headers, "Subject"),
					body,
					headers: headersRecord,
					attachments: collectAttachments(payload),
				});
			}

			return results;
		},
		description:
			"Fetch all messages in a Gmail thread by threadId, in chronological order. Unlike getMessages, this preserves quoted reply chains so the full conversation context is available. Use this before replying to understand the complete thread history.",
		returnType:
			"Promise<Array<{ id: string; subject?: string; from?: string; to?: string; date?: string; body: string; threadId?: string; labelIds?: string[] }>>",
		parameters: [{ name: "threadId", type: "string" }],
		metadata: {
			category: "google",
			tags: ["readonly", "auth", "discovery"],
			readonly: true,
			discovery: true,
			version: "1.0.0",
			relatedTo: ["getMessage", "getMessages", "replyToMessage"],
		},
		docs: {
			summary:
				"Fetch all messages in a Gmail thread in chronological order. Preserves quoted reply content so the full conversation history is visible. Essential context before generating a reply.",
			parameters: [
				{
					name: "threadId",
					type: "string",
					description:
						"The Gmail thread ID (available as threadId on any GmailMessage object)",
					example: '"18f3a..."',
				},
			],
			returns: {
				type: "Promise<GmailMessage[]>",
				description: "Chronological array of all messages in the thread.",
				example:
					'[{ id: "18f...", from: "alice@example.com", subject: "Re: Project", body: "..." }, ...]',
			},
			examples: [
				{
					title: "Get full thread before replying",
					code: `const msgs = await gmail.getMessages("is:unread", 5);
for (const msg of msgs) {
  const thread = await gmail.getThread(msg.threadId);
  const history = thread.map(m => \`[\${m.from}]: \${m.body}\`).join("\\n\\n---\\n\\n");
  // pass history to agent for context
}`,
				},
			],
			seeAlso: ["getMessage", "getMessages", "replyToMessage"],
		},
	},
];
