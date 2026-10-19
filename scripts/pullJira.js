#!/usr/bin/env node
/**
 * Pull real bug screenshots from JIRA into benchmark/cases/jira/ so we can tune
 * PixelSentry against actual reported defects (cropping, alignment, overflow…).
 *
 * Reads credentials from .env ONLY (never hardcode/print/commit them):
 *   JIRA_SITE=your-org.atlassian.net
 *   JIRA_EMAIL=you@example.com
 *   JIRA_TOKEN=<Atlassian API token>          # rotate if it was ever exposed
 *   JIRA_PROJECTS=OQG3,QCI,QGAI,QGC           # comma-separated project keys
 *
 * Usage:
 *   node scripts/pullJira.js                  # default bug keywords
 *   node scripts/pullJira.js --max 40         # cap downloaded images
 *   node scripts/pullJira.js --jql 'project = QCI AND labels = ui'  # custom JQL
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");

const OUT_DIR = path.join(__dirname, "..", "benchmark", "cases", "jira");

// Keywords that tend to mark visual/responsive bugs. Matched against summary
// and full text. Tune freely.
const KEYWORDS = ["crop", "cut off", "align", "overflow", "clip", "truncat", "overlap", "responsive", "RTL", "off screen", "not visible"];

function parseArgs(argv) {
    const args = { max: 60 };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--max") args.max = Number(argv[++i]) || args.max;
        else if (argv[i] === "--jql") args.jql = argv[++i];
    }
    return args;
}

function requireEnv() {
    const site = process.env.JIRA_SITE;
    const email = process.env.JIRA_EMAIL;
    const token = process.env.JIRA_TOKEN;
    const projects = (process.env.JIRA_PROJECTS || "").split(",").map(s => s.trim()).filter(Boolean);
    const missing = [];
    if (!site) missing.push("JIRA_SITE");
    if (!email) missing.push("JIRA_EMAIL");
    if (!token) missing.push("JIRA_TOKEN");
    if (missing.length) {
        console.error(
            `Missing in .env: ${missing.join(", ")}.\n` +
            `Add your JIRA_* values to .env (git-ignored) and re-run. ` +
            `If the token was pasted anywhere, rotate it in Atlassian first.`
        );
        process.exit(1);
    }
    return { site: site.replace(/^https?:\/\//, "").replace(/\/$/, ""), email, token, projects };
}

function buildJql(projects) {
    const proj = projects.length ? `project in (${projects.join(",")}) AND ` : "";
    const kw = KEYWORDS.map(k => `text ~ "${k}"`).join(" OR ");
    return `${proj}(${kw}) ORDER BY updated DESC`;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const { site, email, token, projects } = requireEnv();
    const auth = "Basic " + Buffer.from(`${email}:${token}`).toString("base64");
    const headers = { authorization: auth, accept: "application/json", "content-type": "application/json" };
    const base = `https://${site}`;
    const jql = args.jql || buildJql(projects);

    console.log(`JIRA: ${site}\nJQL:  ${jql}\n`);

    // Page through issues (new search/jql endpoint uses nextPageToken).
    const issues = [];
    let nextPageToken;
    for (let page = 0; page < 10; page++) {
        const body = {
            jql,
            maxResults: 100,
            fields: ["summary", "attachment"],
            ...(nextPageToken ? { nextPageToken } : {})
        };
        // eslint-disable-next-line no-await-in-loop
        const res = await fetch(`${base}/rest/api/3/search/jql`, { method: "POST", headers, body: JSON.stringify(body) });
        if (!res.ok) {
            const t = await res.text();
            console.error(`JIRA search failed (HTTP ${res.status}): ${t.slice(0, 300)}`);
            process.exit(1);
        }
        // eslint-disable-next-line no-await-in-loop
        const data = await res.json();
        issues.push(...(data.issues || []));
        nextPageToken = data.nextPageToken;
        if (!nextPageToken) break;
    }
    console.log(`Matched ${issues.length} issue(s).`);

    fs.mkdirSync(OUT_DIR, { recursive: true });
    let downloaded = 0;
    const manifest = [];

    for (const issue of issues) {
        if (downloaded >= args.max) break;
        const atts = (issue.fields && issue.fields.attachment) || [];
        const images = atts.filter(a => /^image\//i.test(a.mimeType || ""));
        let n = 0;
        for (const a of images) {
            if (downloaded >= args.max) break;
            n++;
            const ext = (a.filename && path.extname(a.filename)) || ".png";
            const name = `${issue.key}-${n}${ext}`.replace(/[^A-Za-z0-9._-]/g, "_");
            const file = path.join(OUT_DIR, name);
            try {
                // eslint-disable-next-line no-await-in-loop
                const r = await fetch(a.content, { headers: { authorization: auth } });
                if (!r.ok) { console.warn(`  skip ${name} (HTTP ${r.status})`); continue; }
                // eslint-disable-next-line no-await-in-loop
                const buf = Buffer.from(await r.arrayBuffer());
                fs.writeFileSync(file, buf);
                downloaded++;
                manifest.push({ file: name, issue: issue.key, summary: (issue.fields.summary || "").slice(0, 120) });
            } catch (err) {
                console.warn(`  error ${name}: ${err.message}`);
            }
        }
        if (n) console.log(`  ${issue.key}: ${Math.min(n, images.length)} image(s) — ${(issue.fields.summary || "").slice(0, 70)}`);
    }

    fs.writeFileSync(path.join(OUT_DIR, "_manifest.json"), JSON.stringify(manifest, null, 2));
    console.log(`\nDownloaded ${downloaded} image(s) to ${OUT_DIR}\nManifest: benchmark/cases/jira/_manifest.json`);
    console.log(`Next: I'll label the useful ones in benchmark/cases.json and tune the checks against them.`);
}

main().catch(err => { console.error(err); process.exit(1); });
