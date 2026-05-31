// ─── CSV parsing & complaint accessors ──────────────────────────────────────
// Tailored to the Metabase export schema:
//   Data Date, Created At, Trip ID, Sender ID, Content,
//   Trip Info → Driver ID,
//   Vehicle Telemetry 1min - Driver → Vhs   (speed),
//   Vehicle Telemetry 1min - Driver → Location Lat,
//   Vehicle Telemetry 1min - Driver → Location Lon

// Known customer-complaint phrases → English gloss (extend as needed).
export const COMPLAINT_GLOSS = {
  "รถมาล่าช้า": "Car arriving late",
  "รถไม่ขยับ": "Car not moving",
  "รถติด": "Stuck in traffic",
  "คนขับหยุดรถ": "Driver stopped the car",
};

// Proper CSV tokenizer: respects quoted fields containing commas.
function splitCSVLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ",") { out.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

// Map a raw header to a canonical key by keyword (robust to →, -, spacing).
function canonicalKey(raw) {
  const h = raw.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (h.includes("driver") && h.includes("id")) return "driver_id";
  if (h.includes("trip") && h.includes("id")) return "trip_id";
  if (h.includes("sender")) return "sender_id";
  if (h.includes("content")) return "content";
  if (h.includes("created")) return "timestamp";
  if (h.includes("data date")) return "data_date";
  if (h.includes("vhs") || h.includes("speed")) return "speed";
  if (h.includes("lat")) return "lat";
  if (h.includes("lon") || h.includes("lng")) return "lng";
  return h.replace(/\s+/g, "_");
}

export function parseCSV(text) {
  const lines = text.replace(/\r/g, "").trim().split("\n");
  if (!lines.length) return [];
  const headerKeys = splitCSVLine(lines[0]).map(canonicalKey);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const vals = splitCSVLine(lines[i]);
    const obj = {};
    headerKeys.forEach((k, idx) => (obj[k] = vals[idx] ?? ""));
    rows.push(obj);
  }
  return rows;
}

// Strip "° N" / "° E" suffixes; apply sign for S/W.
export function parseCoord(s) {
  if (s == null) return 0;
  const str = String(s);
  const neg = /[swSW]/.test(str);
  const num = parseFloat(str.replace(/[^0-9.]/g, ""));
  if (isNaN(num)) return 0;
  return neg ? -num : num;
}

function speedOf(row) {
  const v = parseFloat(row.speed ?? row.vhs ?? NaN);
  return isNaN(v) ? null : v;
}

// One complaint case = one Trip ID (fallback: sender + data date).
export function groupComplaints(rows) {
  const groups = {};
  for (const row of rows) {
    const key = row.trip_id || `${row.sender_id || "s"}_${row.data_date || ""}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(row);
  }
  return Object.entries(groups).map(([id, telemetry]) => ({ id, telemetry }));
}

export function avgSpeed(telemetry) {
  const speeds = telemetry.map(speedOf).filter((s) => s != null);
  return speeds.length
    ? (speeds.reduce((a, b) => a + b, 0) / speeds.length).toFixed(1)
    : "N/A";
}

export function lastLocation(telemetry) {
  const last = telemetry[telemetry.length - 1] || {};
  return { lat: parseCoord(last.lat), lng: parseCoord(last.lng) };
}

export function getDriverId(telemetry) {
  return telemetry[0]?.driver_id || "unknown";
}

export function getTripId(telemetry) {
  return telemetry[0]?.trip_id || "unknown";
}

export function getSenderId(telemetry) {
  return telemetry[0]?.sender_id || "unknown";
}

export function getTimestamp(telemetry) {
  return telemetry[telemetry.length - 1]?.timestamp || "";
}

// Unique customer-complaint phrases in this case, with English gloss.
export function complaintContents(telemetry) {
  const seen = [];
  for (const r of telemetry) {
    const c = (r.content || "").trim();
    if (c && !seen.includes(c)) seen.push(c);
  }
  return seen.map((c) => ({ text: c, gloss: COMPLAINT_GLOSS[c] || null }));
}

// Readable one-line label, e.g. "รถไม่ขยับ (Car not moving), รถมาล่าช้า (Car arriving late)"
export function complaintLabel(telemetry) {
  const cs = complaintContents(telemetry);
  if (!cs.length) return "—";
  return cs.map((c) => (c.gloss ? `${c.text} (${c.gloss})` : c.text)).join(", ");
}

// Extract HH:MM from a "Created At" string.
function minuteOf(ts) {
  const m = String(ts).match(/(\d{1,2}:\d{2})/);
  return m ? m[1] : ts;
}

// Compact telemetry summary for the model (avoids dumping 180 raw readings).
export function telemetrySummary(telemetry) {
  const speeds = telemetry.map(speedOf).filter((s) => s != null);
  const maxSpeed = speeds.length ? Math.max(...speeds) : 0;
  const avg = speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0;
  const stopped = speeds.filter((s) => s < 5).length;
  const pctStopped = speeds.length ? Math.round((stopped / speeds.length) * 100) : 0;

  // Per-minute average speed trace.
  const buckets = {};
  for (const r of telemetry) {
    const m = minuteOf(r.timestamp);
    const s = speedOf(r);
    if (s == null) continue;
    if (!buckets[m]) buckets[m] = [];
    buckets[m].push(s);
  }
  const perMinute = Object.entries(buckets).map(([m, arr]) => ({
    minute: m,
    avg: +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1),
  }));

  return {
    readings: speeds.length,
    minutes: perMinute.length,
    span: telemetry.length
      ? `${minuteOf(telemetry[0].timestamp)}–${minuteOf(getTimestamp(telemetry))}`
      : "",
    avgSpeed: +avg.toFixed(1),
    maxSpeed,
    pctStopped,
    perMinute,
  };
}
