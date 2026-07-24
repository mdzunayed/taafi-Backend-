# Deploying the Taafi API to Render (free tier)

Everything below stays inside free plans: Render free web service, MongoDB
Atlas M0, Cloudinary free. Total cost: $0.

---

## 0. What the free tier costs you (read this first)

These are not blockers, but they change what "workable APK" means:

| Limitation | Effect on your users | Mitigation |
|---|---|---|
| Instance sleeps after **15 min idle** | First request after a quiet period takes **30–60s**. To a user, the app looks frozen on the login screen. | Free uptime pinger (step 6) + a loading state in the app |
| **Ephemeral disk** | Anything in `./uploads` is deleted on every restart/redeploy. Profile photos and service images vanish. | Cloudinary (step 2) — **required, not optional** |
| **512MB RAM** | Chromium can't run. `GET /api/prescriptions/:id/download` returns 503. | Ship without PDF download, or move to Docker/paid later |
| **750 instance-hours/month** across all free services | One always-on service ≈ 730h. A second free service will exhaust the pool. | Keep this as your only free web service |

---

## 1. MongoDB Atlas (database)

1. Create a free account at <https://cloud.mongodb.com>, then a new
   **M0 (free) cluster**. Pick the region closest to your users
   (`ap-south-1` / Mumbai is nearest to Bangladesh).
2. **Database Access** → Add user. Save the username + password.
3. **Network Access** → Add IP Address → **Allow access from anywhere**
   (`0.0.0.0/0`). Render's free tier has no static outbound IP, so an
   allow-list is not possible here.
4. **Connect** → *Drivers* → copy the SRV string. It looks like:

   ```
   mongodb+srv://<user>:<password>@cluster0.abcde.mongodb.net/taafi?retryWrites=true&w=majority
   ```

   Replace `<password>` with the real one (URL-encode any special
   characters) and make sure `/taafi` is present before the `?` — without a
   database name Mongo falls back to `test`.

## 2. Cloudinary (image storage — required)

Render's disk is wiped on every deploy, so local `./uploads` writes do not
survive. `src/middleware/upload.js` already prefers Cloudinary when it is
configured and silently falls back to disk when it isn't — so if you skip
this step, uploads will appear to work and then disappear.

1. Sign up at <https://cloudinary.com> (free tier is generous).
2. Dashboard → copy the **API Environment variable**, the
   `CLOUDINARY_URL=cloudinary://...` one.

## 3. Push to GitHub

The repo is already wired to `github.com/mdzunayed/taafi-Backend-`:

```bash
git add -A
git commit -m "Prepare backend for Render deployment"
git push origin main
```

Confirm `.env` is **not** in the commit — it is gitignored, and the real
secrets belong in Render's dashboard instead.

## 4. Create the Render service

1. Sign up at <https://render.com> with your GitHub account.
2. **New → Blueprint**, select the `taafi-Backend-` repo. Render reads
   [`render.yaml`](render.yaml) and pre-fills the plan, region, build and
   start commands, and the health check path.
3. It will prompt for the four secrets marked `sync: false`:

   | Variable | Value |
   |---|---|
   | `MONGO_URI` | the Atlas SRV string from step 1 |
   | `JWT_SECRET` | generate one: `openssl rand -hex 32` |
   | `CLOUDINARY_URL` | from step 2 |
   | `PUBLIC_BASE_URL` | leave blank for now — you don't know the URL yet |
   | `CORS_ALLOWED_ORIGINS` | leave blank if you only ship the mobile app |

4. Deploy. First build takes ~3–5 minutes.

> Prefer clicking through by hand instead of a blueprint? **New → Web
> Service**, runtime **Node**, build `npm ci --omit=dev`, start `npm start`,
> health check path `/health`, then add every variable from `render.yaml`
> manually — including `PUPPETEER_SKIP_DOWNLOAD=1` and `TRUST_PROXY_HOPS=1`.

## 5. Set `PUBLIC_BASE_URL` and verify

Render assigns a hostname like `https://taafi-api.onrender.com`. Put it into
`PUBLIC_BASE_URL` in the dashboard (Environment tab) and let it redeploy.
It is used to build absolute image URLs, so leaving it unset yields broken
images in the app.

Then verify from your machine:

```bash
curl https://taafi-api.onrender.com/health
# → {"ok":true,"uptime":12.34}
```

Check the Render **Logs** tab for these three lines:

```
[mongo] connected to mongodb+srv://...
[queue] Redis disabled — jobs run inline, no worker started
[api] listening on 0.0.0.0:10000
```

The Redis line is expected and harmless — without `REDIS_URL` the cache
becomes a pass-through and background jobs run inline. The API is fully
functional; you only lose the performance headroom.

## 6. Keep it awake (optional but recommended)

Register a free cron at <https://cron-job.org> hitting
`https://taafi-api.onrender.com/health` every 10 minutes. The global rate
limiter already skips `/health`, so the pings cost you nothing.

This does not fully eliminate cold starts (Render still recycles free
instances), so keep a proper loading indicator in the app regardless.

## 7. Point the Flutter app at it

Rebuild the APK against the deployed URL rather than a hard-coded LAN IP:

```bash
flutter build apk --release \
  --dart-define=API_BASE_URL=https://taafi-api.onrender.com
```

Before distributing, confirm on a real device over **mobile data** (not
Wi-Fi — that can mask a leftover `192.168.x.x` fallback) that login,
image upload, and chat all work.

Android blocks cleartext HTTP by default, but Render serves HTTPS, so no
`usesCleartextTraffic` exception is needed. Make sure every URL in the app
is `https://`.

---

## Deployment changes already applied

- `src/server.js` — removed a shadowed `PORT` declaration that pinned the
  listener to a hard-coded fallback, and bound `0.0.0.0` so Render's health
  checker can reach the process.
- `src/utils/prescriptionPdf.js` — puppeteer is now required lazily. A
  top-level require would crash the whole API at boot on a runtime without
  Chromium; now only the PDF endpoint degrades, returning a 503 with a clear
  message. Also added `--disable-dev-shm-usage` / `--disable-gpu` so
  Chromium fits in 512MB wherever it *is* available.
- `package.json` — pinned `engines.node` to 20.x, matching local dev.
- `render.yaml` — the blueprint described above.
- `.gitignore` — stopped tracking the `_cdp_tmp.js` / `_seed_wallet_tmp.js`
  scratch scripts.

## Troubleshooting

**Build fails downloading Chromium** — `PUPPETEER_SKIP_DOWNLOAD=1` is
missing or was added after the build started. Add it, then **Manual Deploy →
Clear build cache & deploy**.

**`[mongo] connection error: ... ENOTFOUND`** — the SRV hostname is wrong, or
Atlas Network Access is not open to `0.0.0.0/0`.

**Everyone gets rate-limited at once** — `TRUST_PROXY_HOPS=1` is missing, so
`express-rate-limit` is keying every request to Render's proxy IP and
treating all users as one client.

**Uploaded images 404 after a redeploy** — `CLOUDINARY_URL` is unset, so
uploads went to the ephemeral disk. Set it; note that images uploaded before
the fix are gone for good.

**Socket.io disconnects constantly** — expected when the instance sleeps.
The Flutter client should reconnect automatically; verify its reconnect
logic before shipping the APK.
