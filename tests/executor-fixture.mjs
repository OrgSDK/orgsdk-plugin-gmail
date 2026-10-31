import assert from "node:assert/strict";
import nock from "nock";

const message = {
	id: "message",
	threadId: "thread",
	labelIds: ["INBOX"],
	snippet: "Synthetic message",
	payload: {
		mimeType: "text/plain",
		headers: [
			{ name: "From", value: "sender@example.invalid" },
			{ name: "To", value: "recipient@example.invalid" },
			{ name: "Subject", value: "Synthetic subject" },
			{ name: "Message-ID", value: "<fixture@example.invalid>" },
		],
		body: { data: Buffer.from("Synthetic body").toString("base64url") },
	},
};
export default async function createFixture() {
	const fixture = {
		nativeNetworkMock: true,
		nativeRequests: 0,
		configuration: {},
		provider: "google-oauth",
		secret: {
			source: "byo",
			secret_accessToken: "synthetic-access",
		},
		async fetch(request) {
			const url = new URL(request.url);
			assert.equal(
				request.headers.get("authorization"),
				"Bearer synthetic-access",
			);
			assert.equal(url.origin, "https://gmail.googleapis.com");
			const path = url.pathname;
			const base = "/gmail/v1/users/me";
			if (path === `${base}/messages` && request.method === "GET")
				return Response.json({
					messages: [{ id: "message" }],
					resultSizeEstimate: 1,
				});
			if (path === `${base}/messages/message`) return Response.json(message);
			if (path === `${base}/labels`)
				return Response.json(
					request.method === "POST"
						? { id: "label", name: "Fixture" }
						: { labels: [{ id: "INBOX", name: "INBOX" }] },
				);
			if (path === `${base}/messages/message/modify`)
				return Response.json(message);
			if (path === `${base}/messages/batchModify`)
				return new Response(null, { status: 204 });
			if (path === `${base}/messages/send`) {
				assert.equal(request.method, "POST");
				const body = await request.json();
				assert(body.raw);
				return Response.json({ id: "sent", threadId: "thread" });
			}
			if (path === `${base}/messages/message/attachments/attachment`)
				return Response.json({
					data: Buffer.from("attachment").toString("base64url"),
					size: 10,
				});
			if (path === `${base}/threads/thread`)
				return Response.json({ id: "thread", messages: [message] });
			assert.fail(path);
		},
		async run(call) {
			assert.equal(
				(await call("getMessages", { query: "is:unread", maxResults: 1 }))[0]
					.id,
				"message",
			);
			assert.equal(
				(await call("getMessage", { id: "message" })).body,
				"Synthetic body",
			);
			assert.equal((await call("listLabels"))[0].id, "INBOX");
			assert.equal(
				(await call("ensureLabel", { name: "Fixture" })).id,
				"label",
			);
			assert.equal(
				(
					await call("modifyMessageLabels", {
						messageId: "message",
						addLabelIds: ["INBOX"],
						removeLabelIds: [],
					})
				).success,
				true,
			);
			assert.equal(
				(
					await call("batchModifyMessages", {
						messageIds: ["message"],
						addLabelIds: ["INBOX"],
						removeLabelIds: [],
					})
				).success,
				true,
			);
			assert.equal(
				(await call("markMessageAsRead", { messageId: "message" })).success,
				true,
			);
			assert.equal(
				(await call("markMessageAsUnread", { messageId: "message" })).success,
				true,
			);
			const mail = {
				to: "recipient@example.invalid",
				subject: "Synthetic",
				body: "Synthetic only",
			};
			assert.equal((await call("sendMessage", mail)).id, "sent");
			assert.equal(
				(
					await call("sendMessageWithAttachment", {
						...mail,
						attachments: [
							{
								filename: "fixture.txt",
								mimeType: "text/plain",
								base64Data: Buffer.from("Example").toString("base64"),
							},
						],
					})
				).id,
				"sent",
			);
			assert.equal(
				(
					await call("replyToMessage", {
						messageId: "message",
						body: "Synthetic reply",
					})
				).id,
				"sent",
			);
			assert.equal(
				(
					await call("getMessageAttachment", {
						messageId: "message",
						attachmentId: "attachment",
					})
				).dataBase64,
				Buffer.from("attachment").toString("base64"),
			);
			assert(
				JSON.stringify(
					await call("getThread", { threadId: "thread" }),
				).includes("message"),
			);
		},
		close() {
			nock.cleanAll();
			nock.enableNetConnect();
			nock.restore();
		},
	};
	nock.disableNetConnect();
	for (const origin of ["https://gmail.googleapis.com"]) {
		for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
			nock(origin)
				.persist()
				.intercept(/.*/, method)
				.reply(async (request) => {
					fixture.nativeRequests++;
					const response = await fixture.fetch(request);
					return [
						response.status,
						Buffer.from(await response.arrayBuffer()),
						Object.fromEntries(response.headers),
					];
				});
		}
	}
	return fixture;
}
