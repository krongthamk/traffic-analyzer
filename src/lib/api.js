import { telemetrySummary, complaintLabel, lastLocation } from "./csv.js";

// ─── Longdo Maps ─────────────────────────────────────────────────────────────

export async function getLongdoPOI(lat, lng, apiKey) {
  try {
    const url = `https://api.longdo.com/POIService/json/search?lon=${lng}&lat=${lat}&span=200m&limit=5&key=${apiKey}`;
    const res = await fetch(url);
    const data = await res.json();
    const pois = (data.data || []).map((p) => p.name || p.t || "Unknown POI");
    return pois.length ? pois : ["No notable POIs nearby"];
  } catch {
    return ["POI lookup failed"];
  }
}

export async function getLongdoReverseGeocode(lat, lng, apiKey) {
  try {
    const url = `https://api.longdo.com/map/json/address?lon=${lng}&lat=${lat}&key=${apiKey}`;
    const res = await fetch(url);
    const data = await res.json();
    return data.road || data.subdistrict || data.district || "Unknown road";
  } catch {
    return "Geocode failed";
  }
}

// ─── Claude classification ───────────────────────────────────────────────────
// NOTE: `anthropic-dangerous-direct-browser-access` is required to call the API
// directly from a browser. The key is read from the user's input at runtime and
// never bundled into the build. See README security notes.

export async function classifyWithClaude(complaint, road, pois, anthropicKey) {
  const sum = telemetrySummary(complaint.telemetry);
  const complaint_text = complaintLabel(complaint.telemetry);
  const { lat, lng } = lastLocation(complaint.telemetry);
  const trace = sum.perMinute.map((p) => `${p.minute}=${p.avg}`).join(", ");

  const prompt = `You are analyzing a rideshare vehicle stop complaint in Bangkok, Thailand.

A customer filed a complaint about this trip. The complaint text (Thai, with gloss) is:
"${complaint_text}"

This is NOT a driver-supplied reason — it is the rider's grievance. You must judge from the telemetry and location whether the vehicle's behaviour plausibly explains the complaint as ordinary traffic/congestion, or whether it looks like a driver compliance issue (idling, parked off-route, taking an unexplained break, etc.).

Telemetry summary (speed in km/h):
- Readings: ${sum.readings} over ${sum.minutes} min (${sum.span})
- Average speed: ${sum.avgSpeed}, max: ${sum.maxSpeed}
- Time at <5 km/h: ${sum.pctStopped}%
- Per-minute average speed trace: ${trace}

Location (last fix): ${road} (${lat}, ${lng})
Nearby POIs (within 200m): ${pois.join(", ")}

Classify this stop as one of:
- LEGITIMATE: Speed pattern and location are consistent with traffic, a busy intersection, or congestion that explains the complaint
- SUSPICIOUS: Prolonged stopping not explained by traffic/location — a possible compliance issue warranting manual review
- INCONCLUSIVE: Not enough signal to determine

Respond ONLY as JSON in this exact format (no markdown, no prose outside the JSON):
{
  "verdict": "LEGITIMATE" | "SUSPICIOUS" | "INCONCLUSIVE",
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "reason": "One sentence explanation referencing the telemetry and location",
  "flags": ["list", "of", "specific", "concerns", "or", "empty"]
}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude API ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data.content?.find((b) => b.type === "text")?.text || "{}";
  try {
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch {
    return {
      verdict: "INCONCLUSIVE",
      confidence: "LOW",
      reason: "Could not parse model response",
      flags: [],
    };
  }
}

// ─── Google Drive (optional, via Google Identity Services) ───────────────────
// If a Google OAuth Client ID is supplied, the report is uploaded to Drive and
// auto-converted to a native Google Doc. Otherwise the app falls back to a local
// file download (see report.js / App.jsx).

let gisLoaded = null;
function loadGis() {
  if (gisLoaded) return gisLoaded;
  gisLoaded = new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve();
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load Google Identity Services"));
    document.head.appendChild(s);
  });
  return gisLoaded;
}

function getAccessToken(clientId) {
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: "https://www.googleapis.com/auth/drive.file",
      callback: (resp) => {
        if (resp.error) reject(new Error(resp.error));
        else resolve(resp.access_token);
      },
    });
    client.requestAccessToken();
  });
}

// Uploads HTML and converts it to a Google Doc. Returns the doc URL.
export async function uploadReportToDrive(htmlContent, title, clientId) {
  await loadGis();
  const token = await getAccessToken(clientId);

  const boundary = "-------stopclassifier" + Date.now();
  const metadata = {
    name: title,
    mimeType: "application/vnd.google-apps.document", // triggers HTML→Doc conversion
  };
  const body =
    `--${boundary}\r\n` +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    JSON.stringify(metadata) +
    `\r\n--${boundary}\r\n` +
    "Content-Type: text/html; charset=UTF-8\r\n\r\n" +
    htmlContent +
    `\r\n--${boundary}--`;

  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  );

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Drive upload ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.webViewLink || `https://docs.google.com/document/d/${data.id}/edit`;
}
