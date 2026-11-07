# Backup and restore

Business records are in **D1**; photos and logos are in **R2**. Both stay in Cloudflare. Keep backup files **out of GitHub** (`backups/` is git-ignored) and treat them as confidential: they contain customer names and phone numbers.

> The commands below are from Wrangler 4.158's help output. Time Travel retention depends on your plan, so check it in the dashboard.

## D1: database

### Point-in-time restore (Time Travel)

D1 keeps a history you can roll back to. See the current bookmark:

```bash
npx wrangler d1 time-travel info swarna-live-production
```

Restore to a time (ISO timestamp, or a Unix timestamp in seconds):

```bash
npx wrangler d1 time-travel restore swarna-live-production --timestamp=2026-11-07T10:00:00+05:30
```

A restore overwrites the current database. Run `info` first and note the bookmark it prints, so you can undo.

### Full export (do this regularly)

```bash
mkdir -p backups
```
```bash
npx wrangler d1 export swarna-live-production --remote --output backups/swarna-live-$(date +%F).sql
```

### Restore an export into a NEW database (recommended)

```bash
npx wrangler d1 create swarna-live-restore
```
```bash
npx wrangler d1 execute swarna-live-restore --remote --file backups/swarna-live-2026-11-07.sql
```

Check the data, then point `wrangler.jsonc` at the restored database's id and deploy. Do not import an export into a database that already has the tables (it will conflict).

## R2: photos and logos

Photos are stored under `b/<business_id>/photos/YYYY/MM/<photo_id>.<ext>`. The D1 `photos.r2_key` column records each key.

### Copy the whole bucket with rclone (S3-compatible API)

1. Dashboard → R2 → Manage R2 API Tokens → create a token with **Object Read** for `swarna-live-photos-production` (read-only for backups).
2. Configure rclone with the access key, secret and endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` (provider `Cloudflare`).
3. Copy:
   ```bash
   rclone copy r2:swarna-live-photos-production ./backups/photos-$(date +%F) --progress
   ```
To restore, use a token with write access and copy back the other way:
```bash
rclone copy ./backups/photos-2026-11-07 r2:swarna-live-photos-production --progress
```

### Single objects with Wrangler

```bash
npx wrangler r2 object get swarna-live-photos-production/b/<business_id>/photos/2026/11/<photo_id>.jpg --remote --file photo.jpg
```

## Restoring consistently

Restore D1 and R2 from backups taken at about the same time. If R2 is newer than D1, extra photo objects are simply unused. If D1 references a missing photo, the photo shows as "not found". Quotes and figures are still intact.

## Google copies

If Google backup is connected, Drive and Sheets hold extra copies. They are not a substitute for the D1/R2 backups above.

## Suggested routine

- Daily or weekly: D1 export + rclone copy to an encrypted disk or another secure location.
- Before every migration or deploy that changes data: run `d1 time-travel info` and note the bookmark.
- Test a restore into `swarna-live-restore` once a quarter.
