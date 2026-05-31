import { useState, useCallback, useRef, useEffect } from "react";
import {
  parseCSV,
  groupComplaints,
  avgSpeed,
  lastLocation,
  getDriverId,
  getTripId,
  getTimestamp,
  complaintLabel,
  complaintContents,
  telemetrySummary,
} from "./lib/csv.js";
import {
  getLongdoPOI,
  getLongdoReverseGeocode,
  classifyWithClaude,
  uploadReportToDrive,
} from "./lib/api.js";
import { buildReportHtml, buildReportText, downloadFile, computeStats } from "./lib/report.js";

// ─── persisted settings ──────────────────────────────────────────────────────
const LS = "stopclassifier.settings";
function loadSettings() {
  try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch { return {}; }
}
function saveSettings(s) {
  try { localStorage.setItem(LS, JSON.stringify(s)); } catch { /* ignore */ }
}

const VERDICT_STYLES = {
  SUSPICIOUS: { bg: "#ff3b3b22", border: "#ff3b3b", text: "#ff6b6b", dot: "#ff3b3b" },
  LEGITIMATE: { bg: "#00e57622", border: "#00e576", text: "#00e576", dot: "#00e576" },
  INCONCLUSIVE: { bg: "#f5a62322", border: "#f5a623", text: "#f5a623", dot: "#f5a623" },
};

function VerdictBadge({ verdict }) {
  const s = VERDICT_STYLES[verdict] || VERDICT_STYLES.INCONCLUSIVE;
  return (
    <span style={{
      background: s.bg, border: `1px solid ${s.border}`, color: s.text,
      padding: "3px 10px", borderRadius: 4, fontSize: 11,
      fontFamily: "'DM Mono', monospace", fontWeight: 600, letterSpacing: "0.08em",
      display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap",
    }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: s.dot }} />
      {verdict}
    </span>
  );
}

function ResultCard({ complaint, result, index }) {
  const [open, setOpen] = useState(false);
  const { lat, lng } = lastLocation(complaint.telemetry);
  const sum = telemetrySummary(complaint.telemetry);
  const label = complaintLabel(complaint.telemetry);

  return (
    <div style={{
      background: "#0e0e12", border: "1px solid #1e1e28", borderRadius: 10,
      marginBottom: 10, overflow: "hidden",
      borderColor: open ? "#2e2e3e" : "#1e1e28", transition: "border-color 0.2s",
    }}>
      <div onClick={() => setOpen(!open)} style={{
        display: "grid", gridTemplateColumns: "34px 1fr auto auto auto",
        alignItems: "center", gap: 14, padding: "14px 18px", cursor: "pointer",
      }}>
        <span style={{ color: "#444", fontFamily: "'DM Mono', monospace", fontSize: 12 }}>
          {String(index + 1).padStart(2, "0")}
        </span>
        <span style={{ color: "#9a9aa6", fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {label}
        </span>
        <span style={{ color: "#555", fontSize: 12, fontFamily: "'DM Mono', monospace" }}>
          avg {avgSpeed(complaint.telemetry)} · {sum.pctStopped}% stopped
        </span>
        <span style={{ color: "#555", fontSize: 12, fontFamily: "'DM Mono', monospace" }}>
          {getDriverId(complaint.telemetry)}
        </span>
        {result ? <VerdictBadge verdict={result.verdict} /> :
          <span style={{ color: "#444", fontSize: 12, fontFamily: "'DM Mono', monospace" }}>analyzing…</span>}
      </div>

      {open && result && (
        <div style={{ padding: "0 18px 18px", borderTop: "1px solid #1a1a24" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginTop: 16 }}>
            <Panel title="PER-MINUTE SPEED (km/h)">
              <div style={{ display: "flex", gap: 4, alignItems: "flex-end", height: 44 }}>
                {sum.perMinute.map((p, i) => {
                  const h = Math.max(3, Math.min(44, (p.avg / 60) * 44));
                  const c = p.avg < 5 ? "#ff3b3b" : p.avg < 20 ? "#f5a623" : "#00e576";
                  return (
                    <div key={i} title={`${p.minute}: ${p.avg}`} style={{ flex: 1, minWidth: 3 }}>
                      <div style={{ width: "100%", height: h, background: c, borderRadius: 1 }} />
                    </div>
                  );
                })}
              </div>
              <div style={{ color: "#444", fontSize: 10, marginTop: 6, fontFamily: "'DM Mono', monospace" }}>
                {sum.span} · max {sum.maxSpeed}
              </div>
            </Panel>

            <Panel title="LOCATION">
              <div style={{ color: "#888", fontSize: 12, marginBottom: 4 }}>{result.road || "Unknown"}</div>
              <div style={{ color: "#444", fontSize: 11, fontFamily: "'DM Mono', monospace" }}>
                {lat.toFixed(5)}, {lng.toFixed(5)}
              </div>
              {result.pois?.slice(0, 3).map((p, i) => (
                <div key={i} style={{ color: "#555", fontSize: 11, marginTop: 3 }}>· {p}</div>
              ))}
            </Panel>

            <Panel title="AI ASSESSMENT">
              <div style={{ color: "#ccc", fontSize: 12, lineHeight: 1.6, marginBottom: 8 }}>{result.reason}</div>
              <div style={{ color: "#555", fontSize: 10, fontFamily: "'DM Mono', monospace" }}>
                CONFIDENCE · {result.confidence}
              </div>
              {result.flags?.map((f, i) => (
                <div key={i} style={{ color: "#ff6b6b", fontSize: 11, marginTop: 3 }}>⚑ {f}</div>
              ))}
            </Panel>
          </div>
          <div style={{ marginTop: 12, display: "flex", gap: 20, flexWrap: "wrap" }}>
            <Meta k="Trip" v={getTripId(complaint.telemetry)} />
            <Meta k="Driver" v={getDriverId(complaint.telemetry)} />
            <Meta k="Last reading" v={getTimestamp(complaint.telemetry)} />
            <Meta k="Telemetry rows" v={complaint.telemetry.length} />
          </div>
        </div>
      )}
    </div>
  );
}

const Panel = ({ title, children }) => (
  <div style={{ background: "#08080c", borderRadius: 8, padding: 14 }}>
    <div style={{ color: "#444", fontSize: 10, letterSpacing: "0.12em", marginBottom: 10, fontFamily: "'DM Mono', monospace" }}>{title}</div>
    {children}
  </div>
);

const Meta = ({ k, v }) => (
  <div>
    <div style={{ color: "#3a3a44", fontSize: 9, letterSpacing: "0.1em", fontFamily: "'DM Mono', monospace" }}>{k.toUpperCase()}</div>
    <div style={{ color: "#777", fontSize: 12, fontFamily: "'DM Mono', monospace", marginTop: 2 }}>{v}</div>
  </div>
);

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const initial = loadSettings();
  const [longdoKey, setLongdoKey] = useState(initial.longdoKey || "");
  const [anthropicKey, setAnthropicKey] = useState(initial.anthropicKey || "");
  const [googleClientId, setGoogleClientId] = useState(initial.googleClientId || "");
  const [complaints, setComplaints] = useState([]);
  const [results, setResults] = useState({});
  const [status, setStatus] = useState("idle");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [err, setErr] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [exportState, setExportState] = useState("idle");
  const [docUrl, setDocUrl] = useState(null);
  const fileRef = useRef();

  useEffect(() => { saveSettings({ longdoKey, anthropicKey, googleClientId }); },
    [longdoKey, anthropicKey, googleClientId]);

  const handleFile = useCallback((file) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const rows = parseCSV(e.target.result);
      setComplaints(groupComplaints(rows));
      setResults({}); setStatus("idle"); setErr(""); setDocUrl(null); setExportState("idle");
    };
    reader.readAsText(file);
  }, []);

  const runAnalysis = async () => {
    if (!longdoKey || !anthropicKey || !complaints.length) return;
    setStatus("running"); setErr("");
    setProgress({ done: 0, total: complaints.length });
    const acc = {};
    try {
      for (let i = 0; i < complaints.length; i++) {
        const c = complaints[i];
        const { lat, lng } = lastLocation(c.telemetry);
        const [road, pois] = await Promise.all([
          getLongdoReverseGeocode(lat, lng, longdoKey),
          getLongdoPOI(lat, lng, longdoKey),
        ]);
        const cls = await classifyWithClaude(c, road, pois, anthropicKey);
        acc[c.id] = { ...cls, road, pois };
        setResults({ ...acc });
        setProgress({ done: i + 1, total: complaints.length });
      }
      setStatus("done");
    } catch (e) {
      setErr(e.message || String(e));
      setStatus("done");
    }
  };

  const handleExport = async () => {
    setExportState("loading"); setErr("");
    const dateStr = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" });
    const html = buildReportHtml(complaints, results, dateStr);
    const title = `Stop Complaint Report – ${dateStr}`;
    if (googleClientId) {
      try {
        const url = await uploadReportToDrive(html, title, googleClientId);
        setDocUrl(url); setExportState("done");
        return;
      } catch (e) {
        setErr(`Drive upload failed (${e.message}). Downloaded a local copy instead.`);
      }
    }
    // Fallback / no client id: download files locally.
    downloadFile(html, `${title}.html`, "text/html");
    downloadFile(buildReportText(complaints, results, dateStr), `${title}.txt`, "text/plain");
    setExportState("done");
  };

  const stats = Object.keys(results).length ? computeStats(complaints, results) : null;
  const flaggedDrivers = stats ? stats.flaggedDrivers : [];

  const field = (label, val, set, ph) => (
    <div>
      <div style={{ color: "#444", fontSize: 10, letterSpacing: "0.12em", fontFamily: "'DM Mono', monospace", marginBottom: 6 }}>{label}</div>
      <input type="password" value={val} onChange={(e) => set(e.target.value)} placeholder={ph}
        style={{ width: "100%", background: "#0e0e12", border: "1px solid #1e1e28", borderRadius: 8,
          padding: "10px 14px", color: "#888", fontFamily: "'DM Mono', monospace", fontSize: 12,
          outline: "none", boxSizing: "border-box" }} />
    </div>
  );

  return (
    <div style={{ minHeight: "100vh", background: "#06060a", color: "#e0e0e8",
      fontFamily: "'DM Sans', sans-serif", padding: "40px 32px", maxWidth: 1100, margin: "0 auto" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500&family=DM+Mono:wght@400;500&family=Syne:wght@700;800&display=swap" rel="stylesheet" />

      <div style={{ marginBottom: 36 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 16, marginBottom: 6 }}>
          <h1 style={{ fontFamily: "'Syne', sans-serif", fontWeight: 800, fontSize: 28, margin: 0, letterSpacing: "-0.02em", color: "#fff" }}>STOP CLASSIFIER</h1>
          <span style={{ color: "#333", fontFamily: "'DM Mono', monospace", fontSize: 12 }}>v0.3</span>
        </div>
        <p style={{ color: "#555", margin: 0, fontSize: 14 }}>Bangkok rideshare · complaint-triggered telemetry analysis</p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 14 }}>
        {field("LONGDO MAP API KEY", longdoKey, setLongdoKey, "xxxxxxxx…")}
        {field("ANTHROPIC API KEY", anthropicKey, setAnthropicKey, "sk-ant-api03-…")}
        {field("GOOGLE OAUTH CLIENT ID (optional)", googleClientId, setGoogleClientId, "….apps.googleusercontent.com")}
      </div>
      <div style={{ color: "#3a3a44", fontSize: 11, marginBottom: 22, fontFamily: "'DM Mono', monospace" }}>
        keys are stored only in this browser (localStorage) and sent directly to each provider
      </div>

      <div onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); e.dataTransfer.files[0] && handleFile(e.dataTransfer.files[0]); }}
        onClick={() => fileRef.current?.click()}
        style={{ border: `1px dashed ${dragOver ? "#3e3e5e" : "#1e1e28"}`, borderRadius: 10,
          padding: "26px 20px", textAlign: "center", cursor: "pointer", marginBottom: 18,
          background: dragOver ? "#0e0e1a" : "transparent", transition: "all 0.2s" }}>
        <input ref={fileRef} type="file" accept=".csv" style={{ display: "none" }}
          onChange={(e) => e.target.files[0] && handleFile(e.target.files[0])} />
        {complaints.length === 0 ? (
          <>
            <div style={{ color: "#333", fontSize: 26, marginBottom: 6 }}>⬆</div>
            <div style={{ color: "#555", fontSize: 13 }}>Drop your Metabase complaint CSV here or click to browse</div>
            <div style={{ color: "#333", fontSize: 11, marginTop: 6, fontFamily: "'DM Mono', monospace" }}>
              expects: Trip ID, Created At, Sender ID, Content, Driver ID, Vhs (speed), Location Lat/Lon
            </div>
          </>
        ) : (
          <div style={{ color: "#666", fontSize: 13 }}>
            ✓ <span style={{ color: "#aaa" }}>{complaints.length} complaint case{complaints.length !== 1 ? "s" : ""}</span> loaded · click to replace
          </div>
        )}
      </div>

      {complaints.length > 0 && (
        <button onClick={runAnalysis} disabled={status === "running" || !longdoKey || !anthropicKey}
          style={{ background: status === "running" ? "#1a1a24" : "#fff",
            color: status === "running" ? "#444" : "#06060a", border: "none", borderRadius: 8,
            padding: "12px 28px", fontFamily: "'DM Mono', monospace", fontWeight: 500, fontSize: 13,
            cursor: status === "running" ? "not-allowed" : "pointer", letterSpacing: "0.06em",
            marginBottom: 14, width: "100%" }}>
          {status === "running" ? `ANALYZING ${progress.done} / ${progress.total}…`
            : `RUN ANALYSIS ON ${complaints.length} CASE${complaints.length !== 1 ? "S" : ""}`}
        </button>
      )}

      {status === "running" && (
        <div style={{ height: 2, background: "#1a1a24", borderRadius: 2, marginBottom: 22, overflow: "hidden" }}>
          <div style={{ height: "100%", background: "#fff", width: `${(progress.done / progress.total) * 100}%`, transition: "width 0.4s ease" }} />
        </div>
      )}

      {err && (
        <div style={{ background: "#ff3b3b10", border: "1px solid #ff3b3b33", borderRadius: 8,
          padding: "12px 16px", marginBottom: 18, color: "#ff8080", fontSize: 12, fontFamily: "'DM Mono', monospace" }}>
          {err}
        </div>
      )}

      {stats && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 14 }}>
          {[
            { label: "SUSPICIOUS", count: stats.counts.compliance, pct: stats.pct.compliance, color: "#ff6b6b" },
            { label: "LEGITIMATE", count: stats.counts.traffic, pct: stats.pct.traffic, color: "#00e576" },
            { label: "INCONCLUSIVE", count: stats.counts.inconclusive, pct: stats.pct.inconclusive, color: "#f5a623" },
          ].map(({ label, count, pct, color }) => (
            <div key={label} style={{ background: "#0e0e12", border: "1px solid #1e1e28", borderRadius: 10, padding: "16px 20px" }}>
              <div style={{ color: "#333", fontSize: 10, letterSpacing: "0.12em", fontFamily: "'DM Mono', monospace", marginBottom: 8 }}>{label}</div>
              <div style={{ color, fontFamily: "'Syne', sans-serif", fontSize: 30, fontWeight: 800, lineHeight: 1 }}>
                {count} <span style={{ fontSize: 14, color: "#555" }}>{pct}%</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {flaggedDrivers.length > 0 && (
        <div style={{ background: "#ff3b3b0e", border: "1px solid #ff3b3b33", borderRadius: 10, padding: "16px 20px", marginBottom: 14 }}>
          <div style={{ color: "#ff6b6b", fontSize: 10, letterSpacing: "0.12em", fontFamily: "'DM Mono', monospace", marginBottom: 10 }}>
            ⚑ DRIVERS FLAGGED FOR COMPLIANCE REVIEW
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {flaggedDrivers.map((d) => (
              <span key={d.driverId} style={{ background: "#ff3b3b18", border: "1px solid #ff3b3b44",
                color: "#ff8080", padding: "4px 12px", borderRadius: 6, fontFamily: "'DM Mono', monospace", fontSize: 12 }}>
                {d.driverId} · {d.incidents}×
              </span>
            ))}
          </div>
        </div>
      )}

      {status === "done" && stats && (
        <div style={{ marginBottom: 22 }}>
          {exportState !== "done" ? (
            <button onClick={handleExport} disabled={exportState === "loading"}
              style={{ background: "transparent", color: exportState === "loading" ? "#444" : "#4a9eff",
                border: `1px solid ${exportState === "loading" ? "#1e1e28" : "#4a9eff44"}`, borderRadius: 8,
                padding: "11px 28px", fontFamily: "'DM Mono', monospace", fontSize: 13,
                cursor: exportState === "loading" ? "not-allowed" : "pointer", letterSpacing: "0.06em", width: "100%" }}>
              {exportState === "loading" ? "GENERATING REPORT…"
                : googleClientId ? "↗ EXPORT DAILY REPORT TO GOOGLE DOCS" : "↓ DOWNLOAD DAILY REPORT (HTML + TXT)"}
            </button>
          ) : (
            <div style={{ background: "#00e57610", border: "1px solid #00e57633", borderRadius: 8,
              padding: "14px 20px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ color: "#00e576", fontFamily: "'DM Mono', monospace", fontSize: 13 }}>
                ✓ {docUrl ? "Google Doc created" : "Report downloaded"}
              </span>
              {docUrl && (
                <a href={docUrl} target="_blank" rel="noreferrer" style={{ color: "#4a9eff",
                  fontFamily: "'DM Mono', monospace", fontSize: 12, textDecoration: "none", borderBottom: "1px solid #4a9eff44" }}>
                  Open in Drive →
                </a>
              )}
            </div>
          )}
        </div>
      )}

      {complaints.length > 0 && (
        <div>
          <div style={{ color: "#333", fontSize: 10, letterSpacing: "0.12em", fontFamily: "'DM Mono', monospace", marginBottom: 12 }}>
            COMPLAINT CASES · click to expand
          </div>
          {complaints.map((c, i) => (
            <ResultCard key={c.id} complaint={c} result={results[c.id]} index={i} />
          ))}
        </div>
      )}
    </div>
  );
}
