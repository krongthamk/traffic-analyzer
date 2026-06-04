import { telemetrySummary, complaintLabel, lastLocation, getTimestamp, nextOccurrenceUnix } from "./csv.js";

// ─── Longdo Maps ─────────────────────────────────────────────────────────────

export async function getLongdoPOI(lat, lng, apiKey) {
  try {
    // POI / place search lives on the search.longdo.com host.
    const url = `https://search.longdo.com/mapsearch/json/search?lon=${lng}&lat=${lat}&span=1km&limit=5&locale=en&key=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const pois = (data.data || []).map((p) => p.name || p.t || "Unknown POI");
    return pois.length ? pois : ["No notable POIs nearby"];
  } catch (e) {
    console.warn("Longdo POI lookup failed:", e.message);
    return ["POI lookup unavailable"];
  }
}

export async function getLongdoReverseGeocode(lat, lng, apiKey) {
  try {
    // Reverse geocoding: /map/services/address (NOT /map/json/address).
    const url = `https://api.longdo.com/map/services/address?lon=${lng}&lat=${lat}&locale=en&noelevation=1&key=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (
      data.road ||
      data.subdistrict ||
      data.district ||
      data.province ||
      "Unknown road"
    );
  } catch (e) {
    console.warn("Longdo reverse geocode failed:", e.message);
    return "Geocode unavailable";
  }
}

// Predicted/typical road speed at a given time, from Longdo RouteService.
// `time` only accepts now or a FUTURE unix time (past is invalid), so callers
// pass the next occurrence of the complaint's weekday+hour to get the typical
// congestion for that time-of-day. Returns { speedKmh, source } or null.
export async function getLongdoTrafficSpeed(lat, lng, timeUnix, apiKey) {
  try {
    const t = timeUnix ? `&time=${timeUnix}` : "";
    const url = `https://api.longdo.com/RouteService/json/traffic/speed?lon=${lng}&lat=${lat}&range=0.001&locale=en${t}&key=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data == null || data.speed == null) return null; // meta-only = no data here
    return { speedKmh: +(data.speed * 3.6).toFixed(1), source: data.source || "unknown", road: data.road || null };
  } catch (e) {
    console.warn("Longdo traffic speed failed:", e.message);
    return null;
  }
}

// Deterministic POI categorization: does a nearby POI justify a stop?
const STOP_JUSTIFYING = ["bts", "mrt", "station", "bus", "interchange", "junction", "intersection", "แยก", "toll", "ทางด่วน", "expressway", "hospital", "โรงพยาบาล", "pier", "ท่าเรือ"];
const NON_ROUTE = ["7-eleven", "seven", "mall", "plaza", "restaurant", "cafe", "coffee", "ร้าน", "ตลาด", "market", "shop", "store"];
export function categorizePOIs(pois) {
  const justifying = [], nonRoute = [];
  for (const p of pois) {
    const l = String(p).toLowerCase();
    if (STOP_JUSTIFYING.some((k) => l.includes(k))) justifying.push(p);
    else if (NON_ROUTE.some((k) => l.includes(k))) nonRoute.push(p);
  }
  return { justifying, nonRoute };
}

// ─── Claude classification ───────────────────────────────────────────────────
// NOTE: `anthropic-dangerous-direct-browser-access` is required to call the API
// directly from a browser. The key is read from the user's input at runtime and
// never bundled into the build. See README security notes.

export async function classifyWithClaude(complaint, road, pois, anthropicKey, longdoKey) {
  const sum = telemetrySummary(complaint.telemetry);
  const complaint_text = complaintLabel(complaint.telemetry);
  const { lat, lng } = lastLocation(complaint.telemetry);
  const trace = sum.perMinute.map((p) => `${p.minute}=${p.avg}`).join(", ");

  // Objective congestion baseline for this segment at this time-of-day.
  const whenUnix = nextOccurrenceUnix(getTimestamp(complaint.telemetry));
  const traffic = longdoKey ? await getLongdoTrafficSpeed(lat, lng, whenUnix, longdoKey) : null;
  const JAM_KMH = 15; // predicted segment speed below this = typically congested
  let trafficLine, segmentJammed;
  if (traffic) {
    segmentJammed = traffic.speedKmh < JAM_KMH;
    trafficLine = `Predicted typical speed on this segment at this time-of-day: ${traffic.speedKmh} km/h (source: ${traffic.source}) → segment is ${segmentJammed ? "TYPICALLY CONGESTED" : "TYPICALLY FREE-FLOWING"}`;
  } else {
    segmentJammed = null;
    trafficLine = "Predicted typical speed: UNAVAILABLE (treat traffic baseline as unknown)";
  }

  // Deterministic POI split.
  const { justifying, nonRoute } = categorizePOIs(pois);

  const prompt = `You are a compliance classifier for a Bangkok rideshare operator. Apply the decision procedure EXACTLY. Do not use intuition beyond it. The same inputs must always yield the same verdict.

CUSTOMER COMPLAINT (Thai, with gloss): "${complaint_text}"
(This is the rider's grievance, not a driver reason.)

TELEMETRY (km/h):
- Readings: ${sum.readings} over ${sum.minutes} min (${sum.span})
- Average: ${sum.avgSpeed}, max: ${sum.maxSpeed}, time under 5 km/h: ${sum.pctStopped}%
- Per-minute trace: ${trace}

LOCATION: ${road} (${lat}, ${lng})
TRAFFIC BASELINE: ${trafficLine}
POIs justifying a stop (transit/junction/toll/hospital): ${justifying.length ? justifying.join(", ") : "none"}
POIs NOT justifying a stop (retail/food/off-route): ${nonRoute.length ? nonRoute.join(", ") : "none"}

DECISION PROCEDURE (evaluate in order, stop at the first rule that matches):
1. If time under 5 km/h < 40% → LEGITIMATE, confidence HIGH (vehicle was largely moving; complaint likely reflects normal slow progress).
2. Else if TRAFFIC BASELINE says TYPICALLY CONGESTED → LEGITIMATE, confidence HIGH (prolonged stop explained by habitual congestion on this segment at this time).
3. Else if a stop-justifying POI is present AND time under 5 km/h < 70% → LEGITIMATE, confidence MEDIUM (stop explained by transit stop/junction/toll).
4. Else if TRAFFIC BASELINE says TYPICALLY FREE-FLOWING AND time under 5 km/h ≥ 70% → SUSPICIOUS, confidence HIGH (long stop with no congestion reason; flag for review). Add a flag if a non-route POI is present.
5. Else if TRAFFIC BASELINE is unknown AND time under 5 km/h ≥ 70% → SUSPICIOUS, confidence LOW (long stop, no traffic data to exonerate).
6. Else → INCONCLUSIVE, confidence LOW.

Respond ONLY as JSON (no markdown, no prose outside it):
{
  "verdict": "LEGITIMATE" | "SUSPICIOUS" | "INCONCLUSIVE",
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "reason": "State which rule number fired and the exact figures that triggered it",
  "flags": ["specific concerns", "or empty"]
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
      temperature: 0,
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
