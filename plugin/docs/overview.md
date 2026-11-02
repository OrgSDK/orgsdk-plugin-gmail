# Current execution contract

Connect a BYO Google OAuth app with the advertised Gmail scope. OrgSDK handles consent, expiry and refresh. The plugin consumes only the fresh access-token snapshot. This does not establish Google app verification or a CASA assessment.

Native OAuth providers receive only `{source: "byo", secret_accessToken}`. The host owns refresh. The first-party relay is retired.

## Historical source reference

The following describes the former author-source host; current npm and native credential behaviour above takes precedence.

# Gmail

Read and send Gmail — messages, threads, labels, and attachments. Uses the
**restricted** `https://mail.google.com/` scope, so it is **BYO-only**: you
must supply your own Google OAuth client (first-party one-click connect is
**not** available for Gmail).

## What it does

The `gmail` plugin exposes full mailbox automation: search and read messages,
manage labels, reply, and send with attachments. It is the ingestion point for
email-driven workflows — invoices, support tickets, lead capture — and pairs
naturally with the `llm` plugin (classify/extract) and `google-sheets`
(persist).

Typical uses:

- **Invoice pipeline** — fetch invoice emails, extract fields with
  `evalStructured`, append rows to a sheet.
- **Support triage** — classify inbound messages, auto-reply to FAQs, escalate
  the rest.
- **Lead capture** — parse enquiry emails and write contacts to storage.
- **Attachment handling** — download attachments, parse PDFs with `parsePdf`.

## Functions

| Function | Purpose |
|---|---|
| `getMessages` | List/search messages (Gmail query syntax). |
| `getMessage` | Get a single message by ID. |
| `getThread` | Get a thread. |
| `getMessageAttachment` | Download an attachment (returns base64). |
| `sendMessage` | Send a message (to/cc/bcc/subject/html). |
| `sendMessageWithAttachment` | Send a message with an attachment. |
| `replyToMessage` | Reply within a thread. |
| `listLabels` / `ensureLabel` | List / create labels. |
| `modifyMessageLabels` | Apply/remove labels (e.g. file into a folder). |
| `batchModifyMessages` | Apply label changes to many messages at once. |
| `markMessageAsRead` / `markMessageAsUnread` | Toggle read state. |

The full function list (parameters, return types) is available via the
`plugins:info` command in the dashboard.

## Credentials

Every function declares `requiredCredentials: ["google-oauth"]`. Gmail uses the
**restricted** mail scope, so a Google credential must be connected before any
function is callable — and it must come from **your own** OAuth client.

| Provider | Type | Connect method |
|---|---|---|
| `google-oauth` | oauth2 | **BYO only.** Paste your own Google OAuth client JSON. The client's granted scopes must include `https://mail.google.com/`. First-party one-click connect is **not** offered for Gmail. |

> **Combining Gmail + Sheets/Tasks.** If you also use `google-sheets` or
> `google-tasks`, connect a single BYO client whose granted scopes cover
> Gmail + Sheets + Tasks. The shared `google-oauth` credential then serves all
> three. (The first-party client covers only Sheets + Tasks — not Gmail.)

## Using it in a workflow

```typescript
// Search recent invoices and extract amounts
const msgs = await getMessages({
  query: "subject:invoice newer_than:7d",
});
for (const m of msgs) {
  const full = await getMessage({ messageId: m.id });
  // const result = await evalStructured(full.body, invoiceSchema);  // llm plugin
  // await appendToSheet({ ... });                                 // google-sheets plugin
}

// Send a styled reply
await replyToMessage({
  threadId,
  body: "Thanks — we've received your invoice and will process it within 2 days.",
});
```

## Notes

- `getMessages` uses Gmail query syntax (`subject:`, `from:`,
  `newer_than:`, `has:attachment`, etc.).
- Attachment bytes are base64 — pass to `parsePdf` (data plugin) or decode for
  files.
- See `guides/usage-patterns.md` for deeper agent-facing patterns.
