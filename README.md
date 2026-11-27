# SR FAB Cloth Bill – Cloudflare version

Same app as before (liquid glass look, dashboard, PhonePe auto-confirm QR, backups),
now running on Cloudflare's free plan. Free limits reset every day, not every month.

## Folder layout (this must be exactly right)
```
wrangler.jsonc
package.json
schema.sql
.gitignore
README.md
src/worker.js
public/index.html
public/thanks.html
backup/srfab-backup.ps1      (stays on your PC, do NOT upload this one)
```

## Step 1 – Cloudflare account and database
1. Sign up free at dash.cloudflare.com.
2. Open **Storage & databases → D1 SQL database → Create database**. Name it `srfab`.
3. On the database page copy the **Database ID** (a long code with dashes).
4. Open the **Console** tab, paste the three lines from `schema.sql`, and press **Execute**.

## Step 2 – GitHub
1. Make a NEW private repository called `srfab-cf`.
2. Unzip this folder. Drag everything INSIDE it (not the outer folder) into the GitHub upload page,
   except the `backup` folder. Check the list shows `src/worker.js` and `public/index.html`. Commit.
3. Open `wrangler.jsonc` on GitHub, click the pencil icon, replace `PUT-YOUR-DATABASE-ID-HERE`
   with your Database ID, and commit.

## Step 3 – Connect the repository to Cloudflare
1. **Workers & Pages → Create → Import a repository (Connect to Git)** and pick `srfab-cf`.
2. Project name: `srfab` (it must match the name in `wrangler.jsonc`).
3. Leave the build command empty. Deploy command: `npx wrangler deploy`. Save and deploy.
4. When it finishes you get a link like `https://srfab.YOURNAME.workers.dev`.

## Step 4 – Secrets
Open your Worker → **Settings → Variables and secrets → Add**. Use type **Secret** for each:

| Name | Value |
|---|---|
| `SHOP_MOBILE` | your 10-digit login number |
| `SHOP_PASSWORD` | a long private password |
| `SESSION_SECRET` | 40+ random letters and numbers |
| `BACKUP_KEY` | 20+ random letters and numbers (for the PC backup script) |
| `PHONEPE_ENV` | `sandbox` (later `production`) |
| `PHONEPE_CLIENT_ID` | from the PhonePe dashboard |
| `PHONEPE_CLIENT_VERSION` | `1` in sandbox |
| `PHONEPE_CLIENT_SECRET` | from the PhonePe dashboard |
| `PHONEPE_WEBHOOK_USER` | a username you invent |
| `PHONEPE_WEBHOOK_PASS` | a long password you invent |

## Step 5 – PhonePe webhook
In the PhonePe dashboard add a webhook:
- URL: `https://srfab.YOURNAME.workers.dev/api/phonepe/webhook`
- Username / password: the same as `PHONEPE_WEBHOOK_USER` / `PHONEPE_WEBHOOK_PASS`
- Events: order completed, order failed

## Step 6 – Move your bills
On the old site open Settings → **Download full backup**. On the new site open Settings →
**Restore backup** and choose that file.

## Free plan limits to know
- 100,000 requests a day, 5 million database rows read a day, 100,000 rows written a day.
- Each request may use about 10 ms of CPU time. The app keeps every request small for this reason.
- The page checks a tiny "version" value every 30 seconds and loads all bills only when something changed.
