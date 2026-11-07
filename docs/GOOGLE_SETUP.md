# Google Drive and Sheets setup

Google is used **only** to save copies of photos and transaction rows. Business sign-in never uses Google.

> **Verification note.** Google's documentation sites could not be opened while this was written. The OAuth endpoints, scopes and API calls in the code match Google's official client libraries (`google-auth-library`, `@googleapis/drive`, `@googleapis/sheets`). The **console steps and policy details** below (testing mode, verification) are from memory, so check them in the Google Cloud console. **The Google integration has only been tested against a simulated Google in the automated tests, not real Google accounts.**

## 1. Create a Google Cloud project

1. Go to https://console.cloud.google.com/ and create a project, e.g. "Swarna Live".
2. APIs & Services → Library → enable **Google Drive API** and **Google Sheets API**.

## 2. OAuth consent screen

1. APIs & Services → OAuth consent screen (in newer consoles: Google Auth Platform → Branding / Audience / Data access).
2. User type **External** (unless every owner uses your Google Workspace).
3. App name "Swarna Live", support email, logo optional. Authorised domain `swarnalive.com`. Add privacy-policy and home-page links (required to publish).
4. Scopes (Data access):
   - `openid`, `email`: to show which Google account is connected
   - `https://www.googleapis.com/auth/drive.file`: **only files and folders Swarna Live creates**
   - `https://www.googleapis.com/auth/spreadsheets`: read and write the spreadsheet the owner chooses

## 3. Create the OAuth client

1. Credentials → Create credentials → OAuth client ID → **Web application**.
2. **Authorised redirect URIs** must match exactly:
   - Production: `https://www.swarnalive.com/api/google/callback`
   - Staging: `https://swarna-live-staging.<YOUR_WORKERS_SUBDOMAIN>.workers.dev/api/google/callback`
   - Local (optional): `http://localhost:8787/api/google/callback`
3. Copy the client ID and secret into Cloudflare secrets:
   ```bash
   npx wrangler secret put GOOGLE_CLIENT_ID
   ```
   ```bash
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   ```
   (and again with `--env staging` if staging has its own client)
4. Make sure `TOKEN_ENCRYPTION_KEY` is set (see DEPLOYMENT.md step 6).

The owner's screen in Settings → Backups also shows the exact redirect URL the app uses.

## 4. Testing mode vs. production

- While the app is in **Testing**, only the test users you list can connect. Google expires refresh tokens for testing-mode apps after about 7 days, so the owner will see "Reconnect needed" weekly. Swarna Live keeps saving locally and pauses backups until they reconnect.
- To remove those limits, **publish** the app. `spreadsheets` is a *sensitive* scope, so Google requires **verification** of the app (domain ownership, privacy policy, a demo video explaining the use). `drive.file` is a non-sensitive scope. Allow time for review.
- Swarna Live deliberately does **not** request the full `drive` scope. That scope is restricted and would require a security assessment.

## 5. What the narrow Drive permission means

With `drive.file`, Swarna Live can only see folders and files **it created**. So in Settings → Backups:
- Use **"Create a backup folder for me"**. Swarna Live creates a private folder in the owner's My Drive. The owner may move or rename it; access continues.
- A link to some *other* existing folder is checked through the Drive API and will be refused with an explanation.
- Spreadsheets: any spreadsheet the connected account can edit works (thanks to the `spreadsheets` scope). Swarna Live only writes to **one worksheet** that it creates, or an **empty** worksheet the owner confirms. Worksheets with other content are refused, never overwritten.

## 6. How syncing behaves

- Photos are uploaded private (no sharing is changed) into `Folder / YYYY / MM / <order no> - Gold 22K.jpg`, with the caption strip that was added when the photo was taken.
- Rows use `RAW` input, so text like `=SUM(...)` is stored as text and never runs as a formula. Phone numbers are text; weights and amounts are numbers. The last column holds Swarna Live's internal record ID and is used to find and update the same row. **Do not edit that column.** Changing a row's order or sorting the sheet is fine.
- Status changes and corrections update the existing row. Changing destinations affects future backups only; rows already written are updated where they are.
- Disconnecting revokes Swarna Live's Google access but **deletes nothing** in Drive or Sheets.
- Owners can download the sheet as Excel: in Google Sheets, **File → Download → Microsoft Excel (.xlsx)**. Swarna Live does not update uploaded Excel files directly.
