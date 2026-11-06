# Gmail for OrgSDK

## Install in OrgSDK

Open your project's Plugins page, select this plugin and enable the pinned release.
The default catalogue is https://orgsdk.ai/plugins/releases.json. The executor
downloads the versioned bundle and verifies its SHA256. Configure the provider
and attach the credential described below before running an action.

The plugin is Apache-2.0 licensed; see LICENSE, NOTICE and TRADEMARKS.md.
The generated npm distribution is a separate publication surface. Installing npm
files alone does not register a project plugin. Local builds do not publish it.

## Credentials

Connect your own Google OAuth application in OrgSDK with `https://mail.google.com/`.
Enable the corresponding Google API and register the exact callback URL shown
by OrgSDK in your Google Cloud OAuth client. Attach the resulting `google-oauth`
credential to this project plugin. The host owns consent and token refresh;
execution receives only `{source: "byo", secret_accessToken}`. Client and refresh
secrets stay on the host. No hosted OAuth relay is supported.

A Google credential may be shared with another Google plugin only when its granted
scopes cover both plugins. Provider consent, app verification and account permissions
are required independently of installing this package.

Gmail uses a restricted scope. Distribution may require Google verification and a CASA assessment; publishing this plugin does not satisfy those requirements. Sending messages changes the recipient mailbox and needs appropriate approval.

## Functions

- `getMessages` — Fetch Gmail messages using Gmail search query syntax (q). Label filters must use the label name (not the label ID), e.g. label:Expense or label:"Expense Reports". Returns cleaned text body optimized for LLM processing. HTML is converted to clean text, tracking pixels and quoted chains are removed.
- `getMessage` — Fetch a single Gmail message by ID. Returns cleaned text body optimized for LLM processing. HTML is converted to clean text, tracking pixels and quoted chains are removed.
- `listLabels` — List Gmail labels (id + name)
- `ensureLabel` — Get or create a Gmail label by name; returns label object (id + name)
- `modifyMessageLabels` — Add/remove Gmail label IDs on a message. Use removeLabelIds:['UNREAD'] to mark as read.
- `batchModifyMessages` — Batch add/remove label IDs across multiple message IDs
- `markMessageAsRead` — Mark Gmail message as read (removes UNREAD label)
- `markMessageAsUnread` — Mark Gmail message as unread (adds UNREAD label)
- `sendMessage` — Send an email via Gmail. Supports plain-text or HTML body. When html is provided, sends a multipart/alternative message with both text/plain and text/html parts.
- `sendMessageWithAttachment` — Send an email with file attachments via Gmail. Builds a MIME multipart/mixed message with a plain-text or HTML body and one or more base64-encoded attachments. When html is provided, the body is nested in multipart/alternative.
- `replyToMessage` — Reply to a Gmail message within its thread. Fetches the original message to set threading headers (In-Reply-To, References) and replies to the original sender. Supports HTML via multipart/alternative when html parameter is provided.
- `getMessageAttachment` — Fetch a Gmail attachment by messageId + attachmentId. Returns standard base64 bytes (dataBase64).
- `getThread` — Fetch all messages in a Gmail thread by threadId, in chronological order. Unlike getMessages, this preserves quoted reply chains so the full conversation context is available. Use this before replying to understand the complete thread history.

## Example action

```typescript
return await gmail.getMessages({ query: "is:unread", maxResults: 10 });
```

Use named argument objects. Exact parameters and return types are in the release catalogue and the project tool contract.
