# Gmail Plugin — Usage Patterns

(BYO only — restricted scope. Sheets/Tasks live in the separate `google` plugin.)

## Connecting

Gmail uses the `https://mail.google.com/` scope, which Google classifies as
**restricted**. It cannot use OrgSDK's first-party (one-click) OAuth. You must
supply your own Google OAuth client:

1. Create a Web-application OAuth client in Google Cloud Console.
2. Add `https://<your-relay>/plugins/gmail/callback` to its redirect URIs.
3. Add the `https://mail.google.com/` scope and complete the consent/CASA process.
4. Paste the client JSON in the Credentials tab, then connect.

A single BYO client granted all scopes (Gmail + Sheets + Tasks) serves both
this plugin and the `google` (sheets/tasks) plugin — credentials are stored
under the shared `google-oauth` provider key.

## Reading and triaging

```
const msgs = await getMessages("is:unread", 20);
for (const m of msgs) {
  const isExpense = await evalBoolean(
    m.body,
    "is an expense receipt or invoice",
    { text: "Your payment of $50 was processed", matches: true },
    { text: "Meeting tomorrow at 3pm", matches: false }
  );
  if (isExpense.result) {
    await modifyMessageLabels(m.id, { addLabelIds: ["Label_Expense"] });
  }
}
```

- Use `query` to filter server-side before processing (label names, not IDs).
- Fetch a thread with `getThread` before `replyToMessage` to preserve
  context (threads keep quoted chains; `getMessages` truncates them).

## Composing with Sheets

Read invoices from Gmail, extract structured data, write to Sheets (google plugin):

```
getMessages({ query: "subject:invoice newer_than:7d" })   // gmail
  → evalStructured(emailBody, invoiceSchema)
  → appendToSheet(spreadsheetId, range, rows)            // google
```
