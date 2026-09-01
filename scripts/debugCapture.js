/**
 * One-off debug: open the local site and print what Playwright actually sees.
 */
const { chromium } = require("playwright");

(async () => {
    const url = process.argv[2] || "http://192.168.1.185:8000/en";
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        locale: "en"
    });
    const page = await context.newPage();

    const consoleErrors = [];
    const failed = [];
    page.on("console", m => {
        if (m.type() === "error") consoleErrors.push(m.text());
    });
    page.on("requestfailed", r =>
        failed.push(`${r.resourceType()} ${r.url()} => ${r.failure()?.errorText}`)
    );

    console.log("GOTO", url);
    try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
        await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(3000);
    } catch (e) {
        console.log("NAV ERR", e.message);
    }

    const info = await page.evaluate(() => ({
        title: document.title,
        url: location.href,
        textLen: (document.body?.innerText || "").trim().length,
        childCount: document.body?.children?.length || 0,
        bg: getComputedStyle(document.body).backgroundColor,
        htmlLen: document.documentElement.outerHTML.length,
        sample: (document.body?.innerText || "").trim().slice(0, 200)
    }));

    const out = "debug-shot.png";
    await page.screenshot({ path: out, fullPage: false });
    const fs = require("fs");
    console.log("INFO", JSON.stringify(info, null, 2));
    console.log("SHOT", out, "bytes", fs.statSync(out).size);
    console.log("CONSOLE", consoleErrors.slice(0, 8));
    console.log("FAILED", failed.slice(0, 15));
    await browser.close();
})().catch(err => {
    console.error(err);
    process.exit(1);
});
