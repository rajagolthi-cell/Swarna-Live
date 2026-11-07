# Troubleshooting

| What you see | Likely cause | What to do |
|---|---|---|
| "Swarna Live is not configured yet (AUTH_PEPPER secret missing)" | Secret not set for this environment | `npx wrangler secret put AUTH_PEPPER` (add `--env staging` for staging) |
| Setup page says the setup code is wrong | `SETUP_TOKEN` differs, or was deleted | Set it again; it only works while no business exists |
| "Swarna Live has already been set up" | A business already exists | Sign in instead. For another business, see OPERATIONS.md |
| Sign-in fails with a 1102 / "exceeded CPU" error | Free-plan CPU limit vs. PBKDF2 hashing | Use Workers Paid (see DEPLOYMENT.md, Plan notes) |
| "Too many sign-in attempts" | Rate limit (8 failures per email per 15 minutes) | Wait 15 minutes, or use a recovery code |
| Profile shows "locked" | 5 wrong PINs | Wait 15 minutes, or the owner uses Employees → Reset PIN |
| Owner forgot the PIN | — | On the PIN screen: "Forgot owner PIN?" and enter the business password |
| Owner forgot the password | — | Sign-in page → "Use a recovery code". New codes are shown afterwards; save them |
| Lost both password and recovery codes | No email reset by design | The administrator restores access manually in D1 (contact your developer) |
| "Your session token is out of date" | Page left open across a sign-in on another tab | Refresh the page |
| "Rate was changed while you were preparing this quote" | Someone updated the business-entered rate | Review the new offer and choose "Save with updated offer" |
| "No gold rate has been entered" | Rates not set | Owner: Settings → Rates |
| "Buyback percentage must be between …" | Staff limits | Owner can widen limits (Settings → Buyback rules) or save with an override reason |
| Photo will not upload | Not an image, under 480 px, or over 25 MB | Retake with the camera; avoid screenshots of tiny images |
| Camera does not open | Browser lacks camera capture | Use "Upload from device" and pick the photo |
| Deploy fails: hostname already has DNS records | Existing `swarnalive.com`/`www` records | See DEPLOYMENT.md step 11. Decide what to do with the existing site first |
| Google: "Swarna Live cannot use that folder" | Limited `drive.file` permission | Use "Create a backup folder for me" |
| Google: "Reconnect needed" every week | OAuth app still in Testing mode | Publish and verify the app (GOOGLE_SETUP.md §4) |
| Google: worksheet "has other content" | Swarna Live never overwrites other data | Choose an empty tab or let it create a new one |
| Backups "Failed: worksheet was deleted/header changed" | Sheet edited by hand | Restore the header or choose a new worksheet, then "Retry Failed Backups" |
| Backups stuck "Pending" | Google temporarily unavailable | They retry automatically (cron every 10 minutes, up to 8 attempts) |
| `/api/...` returns HTML | Should never happen | Check `assets.run_worker_first` is `true` in `wrangler.jsonc` |
| Tests fail with `ERR_MODULE_NOT_FOUND` for workerd | Install scripts were blocked | `npm rebuild workerd esbuild` (npm 11 users: `npm install-scripts approve workerd esbuild`) |
