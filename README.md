# Stop Classifier — Bangkok Rideshare

A standalone, static web app that analyzes complaint-triggered vehicle telemetry to
distinguish **legitimate stops** (traffic, congestion, busy intersections) from
**possible compliance issues** (unexplained idling, parking off-route), and produces
a daily report for operations review.

It runs entirely in the browser — no backend required — and can be hosted on GitHub
Pages, Netlify, Vercel, S3, or any static host.

---

## How it works

1. You upload a complaint CSV exported from Metabase (one or more trips).
2. For each complaint case, the app:
   - Reverse-geocodes the last known location and finds nearby POIs via **Longdo Maps**.
   - Summarizes the telemetry (average/max speed, % time stopped, per-minute trace).
   - Sends that context to **Claude** (Anthropic API), which returns a verdict:
     `LEGITIMATE`, `SUSPICIOUS`, or `INCONCLUSIVE`, with a one-line reason and flags.
3. You get on-screen summary stats, a flagged-driver list, and a one-click
   **daily report** (Google Doc, or downloadable HTML + TXT).

### Expected CSV columns

The parser matches the Metabase export by keyword, so exact header text is flexible.
It recognizes:

| Field            | Example header                                   | Example value              |
|------------------|--------------------------------------------------|----------------------------|
| Complaint time   | `Created At`                                     | `May 25, 2026, 07:17`      |
| Trip (case key)  | `Trip ID`                                        | `6a1392ab06116e01335966a8` |
| Customer         | `Sender ID`                                      | `69e487eb…`                |
| Complaint text   | `Content`                                        | `รถไม่ขยับ`                  |
| Driver           | `Trip Info → Driver ID`                          | `xHry3PSSsYXteaHus`        |
| Speed (km/h)     | `Vehicle Telemetry 1min - Driver → Vhs`          | `0`                        |
| Latitude         | `Vehicle Telemetry 1min - Driver → Location Lat` | `13.80644670° N`           |
| Longitude        | `Vehicle Telemetry 1min - Driver → Location Lon` | `100.52708330° E`          |

A working `public/sample-data.csv` is included.

> **Note on complaints vs. driver reasons:** this export carries the *customer's*
> complaint (the `Content` column), not a categorical driver-supplied reason. The
> classifier therefore judges legitimacy from telemetry + location, using the
> complaint text as context for what the rider experienced.

---

## Run locally

Requires Node.js 18+.

```bash
npm install
npm run dev        # http://localhost:5173
```

Build a static bundle:

```bash
npm run build      # outputs to dist/
npm run preview    # serve the built bundle locally
```

---

## Deploy

### GitHub Pages (automated)

1. Push this project to a GitHub repo.
2. In the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Push to `main`. The included workflow (`.github/workflows/deploy.yml`) builds and
   publishes `dist/` automatically. Your app appears at
   `https://<user>.github.io/<repo>/`.

`vite.config.js` uses `base: "./"` (relative paths), so it works on a project-pages
subpath without changes.

### Any static host

Run `npm run build` and upload the `dist/` folder to Netlify, Vercel, S3 +
CloudFront, Cloudflare Pages, etc.

---

## Configuration (entered in the app, not committed)

| Field                    | Where to get it                                              | Required |
|--------------------------|-------------------------------------------------------------|----------|
| Longdo Map API key       | https://map.longdo.com/api (free tier, < 5 GB/month)        | Yes      |
| Anthropic API key        | https://console.anthropic.com                               | Yes      |
| Google OAuth Client ID   | See below — only needed to write directly to Google Docs    | Optional |

Keys are saved in your browser's `localStorage` and sent directly to each provider.
They are never bundled into the build or committed to the repo.

### Optional: write the report straight to Google Docs

Without this, the report downloads as an HTML + TXT file (the HTML converts to a
Google Doc cleanly if you upload it to Drive). To create the Doc directly:

1. In Google Cloud Console, create an **OAuth 2.0 Client ID** (type: *Web application*).
2. Under **Authorized JavaScript origins**, add the exact origin you host on
   (e.g. `https://<user>.github.io` and `http://localhost:5173` for dev).
3. Enable the **Google Drive API** for that project.
4. Paste the Client ID (`….apps.googleusercontent.com`) into the app's
   "Google OAuth Client ID" field.

The app requests the narrow `drive.file` scope — it can only create/manage files it
makes, not read your existing Drive.

---

## Security notes

- This is a **client-side** app. Calling the Anthropic API from a browser requires the
  `anthropic-dangerous-direct-browser-access` header, which the app sets. This is
  appropriate for a **personal/internal demo where each user enters their own key**.
- Do **not** ship a build with a hard-coded API key, and do not host this as a public
  multi-user tool with a shared key — the key would be exposed to every visitor. For
  production multi-user use, put a small backend proxy in front of the Anthropic API
  and keep the key server-side.
- No telemetry, keys, or report content is sent anywhere except Longdo, Anthropic, and
  (if configured) Google — all directly from your browser.

---

## Project structure

```
stop-classifier/
├── index.html
├── package.json
├── vite.config.js
├── .github/workflows/deploy.yml   # GitHub Pages CI
├── public/
│   └── sample-data.csv            # example export
└── src/
    ├── main.jsx
    ├── App.jsx                    # UI
    └── lib/
        ├── csv.js                 # parsing, grouping, telemetry summary
        ├── api.js                 # Longdo, Claude, Google Drive
        └── report.js              # stats + report builders
```

---

## Tuning

- **Classification logic / thresholds:** edit the prompt in `src/lib/api.js`
  (`classifyWithClaude`). The "< 5 km/h = stopped" threshold lives in
  `telemetrySummary` in `src/lib/csv.js`.
- **Complaint translations:** extend `COMPLAINT_GLOSS` in `src/lib/csv.js`.
- **What counts as traffic vs compliance:** currently derived from the model verdict
  (`LEGITIMATE` = traffic, `SUSPICIOUS` = compliance) in `src/lib/report.js`.
- **Model:** `claude-sonnet-4-20250514` in `src/lib/api.js`. Roughly $0.01–0.02 per
  complaint case.
