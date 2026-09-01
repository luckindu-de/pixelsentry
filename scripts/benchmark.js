#!/usr/bin/env node
/**
 * Screenshot QA benchmark.
 *
 * Runs each labeled case in benchmark/cases.json through the selected vision
 * providers and scores them against ground truth:
 *   - expected[]     issues the model SHOULD catch (regex over title+desc)
 *   - mustNotFlag[]  false positives the model should NOT raise
 *
 * This measures models; it does not fine-tune them. Use it to (a) see which
 * provider/model catches your known defects, and (b) confirm prompt changes
 * fixed a miss or a false positive without regressing the others.
 *
 * Usage:
 *   node scripts/benchmark.js
 *   node scripts/benchmark.js --providers gemini,ollama
 *   node scripts/benchmark.js --case qr-list-390
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { analyzeImage } = require("../services/imageAnalyze");
const { loadConfig } = require("../services/configLoader");
const analyzer = require("../ai/analyzer");

const ROOT = path.join(__dirname, "..", "benchmark");
const CASES_FILE = path.join(ROOT, "cases.json");

const MEDIA = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--providers") args.providers = (argv[++i] || "").split(",").map(s => s.trim()).filter(Boolean);
        else if (argv[i] === "--case") args.case = argv[++i];
        else if (argv[i] === "--delay") args.delay = Number(argv[++i]);
    }
    return args;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Free API tiers cap requests per minute; detect that so we can wait and retry
// instead of reporting a rate-limited call as if the model failed.
function isRateLimited(run) {
    const msg = run && run.verdict && run.verdict.issues && run.verdict.issues[0] && run.verdict.issues[0].description;
    return run && run.verdict && run.verdict.source === "error" && /429|quota|rate limit|exhaust|too many/i.test(msg || "");
}

function dataUrl(file) {
    const ext = path.extname(file).slice(1).toLowerCase();
    return `data:${MEDIA[ext] || "image/png"};base64,${fs.readFileSync(file).toString("base64")}`;
}

function text(issue) {
    return `${issue.title || ""} ${issue.description || ""}`.toLowerCase();
}

/** Score one provider's verdict against a case's ground truth. */
function evaluate(verdict, testCase) {
    const unavailable = !verdict || verdict.source === "error" || verdict.source === "unavailable";
    const issues = unavailable ? [] : (verdict.issues || []);

    const expected = (testCase.expected || []).map(e => {
        const re = new RegExp(e.pattern, "i");
        const hit = issues.find(i => re.test(text(i)));
        return { id: e.id, caught: Boolean(hit), hit: hit && hit.title };
    });
    const forbidden = (testCase.mustNotFlag || []).map(f => {
        const re = new RegExp(f.pattern, "i");
        const bad = issues.find(i => re.test(text(i)));
        return { id: f.id, violated: Boolean(bad), bad: bad && bad.title };
    });

    const known = [...(testCase.expected || []), ...(testCase.mustNotFlag || [])].map(p => new RegExp(p.pattern, "i"));
    const extra = issues.filter(i => !known.some(re => re.test(text(i)))).map(i => i.title);

    // On a page labeled clean, ANY raised issue is a false positive.
    const cleanFlags = testCase.expectClean ? issues.map(i => i.title) : [];

    return {
        unavailable,
        expectClean: Boolean(testCase.expectClean),
        status: verdict && verdict.overallStatus,
        source: verdict && verdict.source,
        caught: expected.filter(e => e.caught).length,
        expectedTotal: expected.length,
        expected,
        violations: forbidden.filter(f => f.violated).length + cleanFlags.length,
        forbidden,
        cleanFlags,
        extra
    };
}

async function main() {
    if (!fs.existsSync(CASES_FILE)) {
        console.error(`No cases file at ${CASES_FILE}`);
        process.exit(1);
    }
    const { cases } = JSON.parse(fs.readFileSync(CASES_FILE, "utf8"));
    const args = parseArgs(process.argv.slice(2));
    const config = loadConfig();

    const available = analyzer.listProviders().filter(p => p.available).map(p => p.name);
    const providers = (args.providers && args.providers.length ? args.providers : available)
        .filter(p => analyzer.PROVIDERS[p]);

    if (!providers.length) {
        console.error("No usable providers. Start Ollama or add API keys to .env.");
        process.exit(1);
    }

    const selected = cases.filter(c => !args.case || c.id === args.case);
    console.log(`\nBenchmark — ${selected.length} case(s) × providers: ${providers.join(", ")}\n`);

    // agg[provider] = { caught, expected, violations, cases, unavailable }
    const agg = {};
    providers.forEach(p => { agg[p] = { caught: 0, expected: 0, violations: 0, cases: 0, unavailable: 0 }; });

    for (const c of selected) {
        const imgPath = path.join(ROOT, c.image);
        if (!fs.existsSync(imgPath)) {
            console.log(`⚠  ${c.id}: image not found (${c.image}) — add it and re-run.\n`);
            continue;
        }
        const tag = c.annotated
            ? "  [marked — has QA marks, so a catch here is assisted/optimistic]"
            : c.expectClean ? "  [clean control]" : "";
        console.log(`━━ CASE ${c.id}  (${c.image})${tag}`);

        const run1 = () => analyzeImage({
            dataUrl: dataUrl(imgPath),
            filename: path.basename(c.image),
            meta: c.meta || {},
            providers,
            config
        });

        // eslint-disable-next-line no-await-in-loop
        let result = await run1();
        // If a provider was rate-limited, wait and try that case once more.
        if (result.providers.some(isRateLimited)) {
            console.log("   … rate-limited; waiting 30s and retrying once");
            // eslint-disable-next-line no-await-in-loop
            await sleep(30000);
            // eslint-disable-next-line no-await-in-loop
            result = await run1();
        }

        for (const run of result.providers) {
            const ev = evaluate(run.verdict, c);
            const a = agg[run.provider];
            a.cases++;
            if (ev.unavailable) { a.unavailable++; }
            a.caught += ev.caught;
            a.expected += ev.expectedTotal;
            a.violations += ev.violations;

            const bestMark = run.provider === result.best ? " ★best" : "";
            if (ev.unavailable) {
                console.log(`   ${run.provider.padEnd(10)} — unavailable (${ev.source})${bestMark}`);
                continue;
            }
            const recallStr = ev.expectClean ? "clean" : `recall ${ev.caught}/${ev.expectedTotal}`;
            console.log(`   ${run.provider.padEnd(10)} status=${ev.status}  ${recallStr}  false-flags ${ev.violations}${bestMark}`);
            ev.expected.forEach(e => console.log(`        ${e.caught ? "✓" : "✗"} expect ${e.id}${e.hit ? `  ← "${e.hit}"` : ""}`));
            ev.forbidden.forEach(f => console.log(`        ${f.violated ? "✗ FALSE FLAG" : "✓ ok"} ${f.id}${f.bad ? `  ← "${f.bad}"` : ""}`));
            if (ev.expectClean && ev.cleanFlags.length) {
                console.log(`        ✗ FALSE FLAGS on clean page: ${ev.cleanFlags.map(t => `"${t}"`).join(", ")}`);
            } else if (!ev.expectClean && ev.extra.length) {
                console.log(`        · other: ${ev.extra.map(t => `"${t}"`).join(", ")}`);
            }
        }
        console.log("");

        // Space out calls so free-tier per-minute limits don't reject later cases.
        const delayMs = Number.isFinite(args.delay) ? args.delay : 6000;
        if (delayMs > 0) await sleep(delayMs); // eslint-disable-line no-await-in-loop
    }

    console.log("═══ SUMMARY ═══");
    for (const p of providers) {
        const a = agg[p];
        const pct = a.expected ? Math.round((a.caught / a.expected) * 100) : 0;
        console.log(`  ${p.padEnd(10)} recall ${a.caught}/${a.expected} (${pct}%)   false-flags ${a.violations}   unavailable ${a.unavailable}/${a.cases}`);
    }
    console.log("");
}

main().catch(err => { console.error(err); process.exit(1); });
