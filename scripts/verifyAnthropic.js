require("dotenv").config({ quiet: true });

const fs = require("fs");
const path = require("path");
const os = require("os");
const { chromium } = require("playwright");
const analyzer = require("../ai/analyzer");
const { loadConfig } = require("../services/configLoader");

const SHOT = path.join(os.tmpdir(), "verify-anthropic.png");
const URL = process.argv[2] || "http://192.168.1.185:8000/en";

async function ensureShot() {
    if (fs.existsSync(SHOT) && fs.statSync(SHOT).size > 30000) return;
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("load", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await page.screenshot({ path: SHOT });
    await browser.close();
}

(async () => {
    await ensureShot();
    console.log("screenshot", SHOT, fs.statSync(SHOT).size, "bytes");
    console.log("workspace header:", process.env.ANTHROPIC_WORKSPACE_ID ? "set" : "not set");

    const config = loadConfig();
    const verdict = await analyzer.runProvider("anthropic", SHOT, {
        page: "Home",
        browser: "chromium",
        language: "en",
        viewport: { name: "iPhone", width: 390, height: 844 },
        config,
        consoleErrors: [],
        failedRequests: [],
        accessibility: {},
        domSummary: {},
        authoritativeFindings: [],
        hints: []
    });

    console.log("source:", verdict.source, "| status:", verdict.overallStatus, "| confidence:", verdict.confidence);
    for (const i of verdict.issues || []) {
        console.log(` - [${i.severity}] ${i.title}: ${String(i.description).slice(0, 220)}`);
    }
})().catch(err => {
    console.error("FAILED:", err.message);
    process.exit(1);
});
