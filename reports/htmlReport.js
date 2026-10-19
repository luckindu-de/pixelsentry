const fs = require("fs");
const path = require("path");

/**
 * Generate a self-contained HTML report.
 *
 * Screenshots are inlined as base64 data URIs so the report can be opened
 * from anywhere (email attachment, artifact store, local disk) without a
 * running server or the scans/ folder alongside it.
 */

function esc(value) {
    return String(value == null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function inlineImage(scanFolder, relativeToScansRoot, scanId) {
    if (!relativeToScansRoot) return null;
    // `relative` is relative to the scans root and includes the scanId.
    const withinScan = relativeToScansRoot.replace(`${scanId}/`, "");
    const abs = path.join(scanFolder, withinScan.split("/").join(path.sep));
    try {
        const b64 = fs.readFileSync(abs).toString("base64");
        return `data:image/png;base64,${b64}`;
    } catch (err) {
        return null;
    }
}

// Friendly, plain-English titles for the internal finding codes.
const TYPE_LABELS = {
    OVERFLOW: "Page too wide (scrolls sideways)",
    OFF_VIEWPORT: "Runs off the screen edge",
    CLIPPED: "Cut off by its box",
    CLIPPED_TEXT: "Text cut off in its box",
    LOCALE_MISMATCH: "Wrong language loaded",
    VIEWPORT_MISMATCH: "Screen size not applied",
    ALIGNMENT: "Not lined up",
    CONTRAST: "Hard-to-read text",
    CLICKABILITY: "Can't be clicked",
    OVERLAP: "Overlapping elements",
    TEXT_OVERFLOW: "Text spilling / cut off",
    BROKEN_IMAGE: "Broken image",
    BROKEN_IMAGES: "Broken image",
    NETWORK_ERROR: "Files failed to load",
    CONSOLE_ERROR: "Browser console errors",
    JS_ERROR: "JavaScript error",
    NAVIGATION: "Page didn't load",
    CAPTURE_ERROR: "Couldn't scan this page"
};

function typeLabel(type) {
    return TYPE_LABELS[type] || String(type || "Issue");
}

function statusBadge(status) {
    return `<span class="badge ${status}">${status}</span>`;
}

function severityBadge(sev) {
    return `<span class="sev ${sev}">${sev}</span>`;
}

function renderFinding(f) {
    const rec = f.recommendation
        ? `<div class="rec"><strong>Recommendation:</strong> ${esc(
              f.recommendation
          )}</div>`
        : "";
    const loc = f.location
        ? `<div class="loc"><strong>Location:</strong> ${esc(f.location)}</div>`
        : "";
    const src =
        f.source === "ai"
            ? '<span class="tag ai">AI</span>'
            : '<span class="tag fact">auto-check</span>';
    const conf =
        typeof f.confidence === "number"
            ? `<span class="conf">${f.confidence}%</span>`
            : "";
    return `
      <div class="finding">
        <div class="finding-head">
          ${severityBadge(f.severity)}
          <span class="ftype">${esc(typeLabel(f.type))}</span>
          ${src}
          ${conf}
        </div>
        <div class="msg">${esc(f.message)}</div>
        ${loc}
        ${rec}
      </div>`;
}

function renderHint(h) {
    return `
      <div class="hint">
        <span class="ftype">${esc(typeLabel(h.type))}</span>
        <span class="msg">${esc(h.message)}</span>
      </div>`;
}

function confBar(conf) {
    const c = typeof conf === "number" ? conf : 0;
    return `<div class="confbar" title="Confidence ${c}%"><span style="width:${c}%"></span></div>`;
}

function renderCard(result, scanFolder, scanId) {
    const img = inlineImage(scanFolder, result.screenshot, scanId);
    const imgHtml = img
        ? `<img class="shot" src="${img}" alt="screenshot" loading="lazy" />`
        : `<div class="shot noshot">No screenshot</div>`;

    const findingsHtml = result.findings.length
        ? result.findings.map(renderFinding).join("")
        : '<div class="finding ok">No user-visible issues detected</div>';

    const hints = result.hints || [];
    const hintsHtml = hints.length
        ? `<details class="hints"><summary>${hints.length} thing(s) to double-check by eye (not counted)</summary>${hints
              .map(renderHint)
              .join("")}</details>`
        : "";

    const reviewFlag = result.needsHumanReview
        ? '<span class="review">NEEDS HUMAN REVIEW</span>'
        : "";

    const aiSrc = result.ai
        ? `<tr><td>AI verdict</td><td>${esc(result.ai.status)} (${esc(
              result.ai.source
          )}, ${esc(result.ai.confidence)}%)</td></tr>`
        : "";

    return `
    <section class="card ${result.status}">
      <div class="card-meta">
        <h3>${esc(result.page)} ${statusBadge(result.status)} ${reviewFlag}</h3>
        <div class="confidence">Confidence ${esc(
            result.confidence
        )}% ${confBar(result.confidence)}</div>
        <table class="meta">
          <tr><td>Path</td><td>${esc(result.path)}</td></tr>
          <tr><td>Device</td><td>${esc(result.viewport.name || "")} (${
        result.viewport.width
    }x${result.viewport.height})</td></tr>
          <tr><td>Browser</td><td>${esc(result.browser)}</td></tr>
          <tr><td>Language</td><td>${esc(result.language)}</td></tr>
          <tr><td>Title</td><td>${esc(result.title)}</td></tr>
          <tr><td>Load time</td><td>${esc(result.loadTime)} ms</td></tr>
          <tr><td>Screens</td><td>${result.screenshots.length}</td></tr>
          ${aiSrc}
        </table>
        <div class="findings">${findingsHtml}</div>
        ${hintsHtml}
      </div>
      <div class="card-shot">${imgHtml}</div>
    </section>`;
}

/**
 * @returns {string} Absolute path to the written report.html
 */
function writeHtmlReport(scanFolder, report) {
    const { scanId, project, generatedAt, summary, results } = report;

    // Show failed first, then warnings, then passes.
    const order = { FAIL: 0, WARN: 1, PASS: 2 };
    const sorted = [...results].sort(
        (a, b) => order[a.status] - order[b.status]
    );

    const cards = sorted
        .map(r => renderCard(r, scanFolder, scanId))
        .join("\n");

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>PixelSentry Report - ${esc(project)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, Arial, sans-serif; margin: 0; background:#f5f6f8; color:#1a1a1a; }
  header { background:#12203a; color:#fff; padding:24px 32px; }
  header h1 { margin:0 0 4px; font-size:22px; }
  header .sub { opacity:.8; font-size:13px; }
  .summary { display:flex; gap:16px; flex-wrap:wrap; padding:24px 32px; }
  .stat { background:#fff; border-radius:10px; padding:16px 20px; min-width:120px; box-shadow:0 1px 3px rgba(0,0,0,.08); }
  .stat .n { font-size:28px; font-weight:700; }
  .stat .l { font-size:12px; text-transform:uppercase; letter-spacing:.05em; opacity:.7; }
  .stat.pass .n { color:#1a7f37; }
  .stat.warn .n { color:#b26a00; }
  .stat.fail .n { color:#c1121f; }
  .cards { padding:0 32px 48px; display:flex; flex-direction:column; gap:20px; }
  .card { background:#fff; border-radius:12px; box-shadow:0 1px 3px rgba(0,0,0,.08); display:grid; grid-template-columns: 1fr 360px; overflow:hidden; border-left:6px solid #ccc; }
  .card.FAIL { border-left-color:#c1121f; }
  .card.WARN { border-left-color:#b26a00; }
  .card.PASS { border-left-color:#1a7f37; }
  .card-meta { padding:18px 20px; }
  .card-meta h3 { margin:0 0 10px; font-size:17px; display:flex; align-items:center; gap:8px; }
  table.meta { font-size:12px; border-collapse:collapse; margin-bottom:12px; }
  table.meta td { padding:2px 10px 2px 0; vertical-align:top; }
  table.meta td:first-child { color:#666; white-space:nowrap; }
  .card-shot { background:#0d1117; display:flex; align-items:flex-start; justify-content:center; }
  img.shot { width:100%; height:auto; display:block; }
  .shot.noshot { color:#888; padding:40px; }
  .badge { font-size:11px; padding:2px 8px; border-radius:999px; color:#fff; }
  .badge.PASS { background:#1a7f37; } .badge.WARN { background:#b26a00; } .badge.FAIL { background:#c1121f; }
  .sev { font-size:10px; padding:1px 6px; border-radius:4px; color:#fff; margin-right:6px; }
  .sev.HIGH { background:#c1121f; } .sev.MEDIUM { background:#b26a00; } .sev.LOW { background:#555; }
  .finding { border-top:1px solid #eee; padding:8px 0; font-size:13px; }
  .finding.ok { color:#1a7f37; }
  .finding-head { display:flex; align-items:center; gap:6px; margin-bottom:2px; }
  .ftype { font-weight:600; font-size:12px; }
  .tag { font-size:10px; padding:1px 6px; border-radius:4px; color:#fff; }
  .tag.ai { background:#5a2ea6; } .tag.fact { background:#0b6b53; }
  .conf { font-size:10px; color:#666; margin-left:auto; }
  .rec, .loc { font-size:12px; color:#444; margin-top:2px; }
  .stat.review .n { color:#5a2ea6; }
  .review { font-size:10px; background:#5a2ea6; color:#fff; padding:2px 8px; border-radius:999px; }
  .confidence { font-size:11px; color:#555; display:flex; align-items:center; gap:8px; margin-bottom:10px; }
  .confbar { flex:1; max-width:160px; height:6px; background:#e5e7eb; border-radius:3px; overflow:hidden; }
  .confbar span { display:block; height:100%; background:#5a2ea6; }
  .hints { margin-top:10px; font-size:12px; }
  .hints summary { cursor:pointer; color:#777; }
  .hint { padding:4px 0; border-top:1px dashed #eee; color:#666; display:flex; gap:8px; }
  .hint .ftype { color:#999; }
  footer { padding:16px 32px 40px; font-size:12px; opacity:.6; }
  @media (max-width:800px){ .card{ grid-template-columns:1fr; } .card-shot{ order:-1; } }
</style>
</head>
<body>
  <header>
    <h1>PixelSentry <span style="font-weight:400;opacity:.7;font-size:14px">· Responsive UI QA report</span></h1>
    <div class="sub">Project: ${esc(project)} &middot; Scan: ${esc(
        scanId
    )} &middot; Generated: ${esc(generatedAt)}</div>
  </header>

  <div class="summary">
    <div class="stat"><div class="n">${summary.total}</div><div class="l">Scanned</div></div>
    <div class="stat pass"><div class="n">${summary.passed}</div><div class="l">Passed</div></div>
    <div class="stat warn"><div class="n">${summary.warnings}</div><div class="l">Warnings</div></div>
    <div class="stat fail"><div class="n">${summary.failed}</div><div class="l">Failed</div></div>
    <div class="stat review"><div class="n">${
        summary.needsHumanReview || 0
    }</div><div class="l">Needs review</div></div>
  </div>

  <div class="cards">
    ${cards}
  </div>

  <footer>PixelSentry &middot; &copy; 2026 Luckindu Dissanayake | QA Engineer</footer>
</body>
</html>`;

    const filepath = path.join(scanFolder, "report.html");
    fs.writeFileSync(filepath, html, "utf8");
    return filepath;
}

module.exports = {
    writeHtmlReport
};
