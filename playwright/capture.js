const { launchBrowser, createContext } = require("./browser");
const { segmentedCapture } = require("./segmentedCapture");
const { runValidators } = require("../validators");
const { createCombinationFolder, screenshotBaseName } = require("../utils/folder");

/**
 * Capture a single page/browser/language/viewport combination.
 *
 * Besides screenshots and validator findings, this also gathers the
 * objective "browser facts" the hybrid pipeline feeds to AI vision:
 * an accessibility-tree summary and a DOM summary. The DOM is treated as
 * context, not verdict.
 *
 * The scan folder is passed in (no module-level state) so scans can run
 * concurrently without leaking folders between each other.
 *
 * @param {object} params
 * @param {string} params.scanFolder Absolute folder for the whole scan.
 * @param {object} params.combination One entry from combinationGenerator.
 * @param {object} [params.config] Normalized config (for check thresholds).
 * @returns {Promise<object>} Raw capture result.
 */
async function capture({ scanFolder, combination, config, storageState }) {
    const { url, browser: browserName, language, viewport } = combination;

    const browser = await launchBrowser(browserName);

    const consoleErrors = [];
    const failedRequests = [];
    const jsErrors = [];
    const imageRequestFailures = [];

    let result;

    try {
        const context = await createContext(browser, viewport, language, { storageState });
        const page = await context.newPage();

        page.on("console", msg => {
            if (msg.type() === "error") {
                consoleErrors.push(msg.text());
            }
        });

        page.on("pageerror", err => {
            jsErrors.push(err.message);
        });

        page.on("requestfailed", request => {
            const entry = {
                url: request.url(),
                error: request.failure()?.errorText || "unknown"
            };
            failedRequests.push(entry);
            if (request.resourceType() === "image") {
                imageRequestFailures.push(entry.url);
            }
        });

        const start = Date.now();
        let navError = null;
        try {
            // "domcontentloaded" first so we don't hang forever on sites that
            // never fire "load". Then wait for visible body content so SPA
            // shells aren't screenshot as a blank white page.
            await page.goto(url, {
                waitUntil: "domcontentloaded",
                timeout: 30000
            });
            await page
                .waitForLoadState("load", { timeout: 15000 })
                .catch(() => {});
        } catch (err) {
            navError = err.message;
        }

        // Wait until the page has some real content. A blank white screenshot
        // almost always means we captured before the app painted - or the
        // host never responded.
        try {
            await page.waitForFunction(
                () => {
                    const body = document.body;
                    if (!body) return false;
                    const text = (body.innerText || "").trim();
                    const kids = body.children.length;
                    return text.length > 20 || kids > 1;
                },
                { timeout: 15000 }
            );
        } catch (err) {
            const blankMsg =
                "Page stayed blank/empty after navigation " +
                `(no visible content within 15s). Check that ${url} is reachable.`;
            navError = navError ? `${navError}; ${blankMsg}` : blankMsg;
        }

        await page.waitForTimeout(800);
        const loadTime = Date.now() - start;

        // Strict validation: did the requested LANGUAGE and SCREEN SIZE actually
        // apply, or did the site redirect / fall back (e.g. ar -> en) or ignore
        // the viewport?
        const pageInfo = await page
            .evaluate(() => ({
                htmlLang: (document.documentElement.getAttribute("lang") || "").trim(),
                pathname: location.pathname,
                innerWidth: window.innerWidth,
                innerHeight: window.innerHeight
            }))
            .catch(() => ({}));
        const base = s => String(s || "").toLowerCase().split("-")[0];
        const pathLocale = (pageInfo.pathname || "").split("/").filter(Boolean)[0] || "";
        const gotLocale = config && config.localeInPath ? pathLocale : (pageInfo.htmlLang || "");
        const localeCheck = {
            requested: language,
            got: gotLocale,
            htmlLang: pageInfo.htmlLang || "",
            ok: !gotLocale || base(gotLocale) === base(language)
        };
        const viewportCheck = {
            requested: { w: viewport.width, h: viewport.height },
            actual: { w: pageInfo.innerWidth || 0, h: pageInfo.innerHeight || 0 },
            // innerWidth can be a scrollbar-width (~17px) smaller than requested.
            ok: !pageInfo.innerWidth || Math.abs(pageInfo.innerWidth - viewport.width) <= 20
        };

        const validators = await runValidators(page, {
            imageRequestFailures,
            config
        });

        const accessibility = await summarizeAccessibility(page);
        const domSummary = await summarizeDom(page);

        const outputFolder = createCombinationFolder(scanFolder, combination);
        const baseName = screenshotBaseName(combination);
        const screenshots = await segmentedCapture(page, outputFolder, baseName);

        result = {
            title: await page.title().catch(() => ""),
            finalUrl: page.url(),
            loadTime,
            navError,
            consoleErrors,
            failedRequests,
            jsErrors,
            accessibility,
            domSummary,
            screenshots,
            validators,
            localeCheck,
            viewportCheck
        };

        await context.close();
    } finally {
        await browser.close();
    }

    return result;
}

/**
 * Summarize the accessibility tree: role counts + a sample of interactive
 * element names. Gives AI structural context without a huge payload.
 */
async function summarizeAccessibility(page) {
    try {
        // page.accessibility was removed in recent Playwright versions. Guard
        // against it so we degrade gracefully (empty summary) instead of
        // throwing "Cannot read properties of undefined (reading 'snapshot')".
        if (!page.accessibility || typeof page.accessibility.snapshot !== "function") {
            return await domInteractiveSummary(page);
        }

        const snapshot = await page.accessibility.snapshot({
            interestingOnly: true
        });
        if (!snapshot) return { roleCounts: {}, interactive: [] };

        const roleCounts = {};
        const interactive = [];
        const INTERACTIVE = new Set([
            "button",
            "link",
            "textbox",
            "checkbox",
            "radio",
            "combobox",
            "menuitem"
        ]);

        const walk = node => {
            if (!node) return;
            if (node.role) {
                roleCounts[node.role] = (roleCounts[node.role] || 0) + 1;
                if (INTERACTIVE.has(node.role) && node.name && interactive.length < 25) {
                    interactive.push(`${node.role}: ${node.name.slice(0, 30)}`);
                }
            }
            (node.children || []).forEach(walk);
        };
        walk(snapshot);

        return { roleCounts, interactive };
    } catch (err) {
        return { roleCounts: {}, interactive: [], error: err.message };
    }
}

/**
 * Fallback interactive summary built from the DOM when Playwright's
 * accessibility snapshot API is unavailable. Gives AI the same kind of
 * "what controls exist" context (role + accessible name) without the a11y tree.
 */
async function domInteractiveSummary(page) {
    try {
        return await page.evaluate(() => {
            const roleCounts = {};
            const interactive = [];
            const nodes = document.querySelectorAll(
                "a[href], button, [role='button'], input, select, textarea, [role='link']"
            );
            for (const el of nodes) {
                const tag = el.tagName.toLowerCase();
                const role =
                    el.getAttribute("role") ||
                    (tag === "a" ? "link" : tag === "button" ? "button" : tag);
                roleCounts[role] = (roleCounts[role] || 0) + 1;
                const name = (
                    el.innerText ||
                    el.getAttribute("aria-label") ||
                    el.getAttribute("title") ||
                    el.value ||
                    ""
                )
                    .trim()
                    .slice(0, 30);
                if (name && interactive.length < 25) {
                    interactive.push(`${role}: ${name}`);
                }
            }
            return { roleCounts, interactive, source: "dom-fallback" };
        });
    } catch (err) {
        return { roleCounts: {}, interactive: [], error: err.message };
    }
}

/**
 * A lightweight DOM census - counts only, not geometry verdicts.
 */
async function summarizeDom(page) {
    try {
        return await page.evaluate(() => {
            const q = sel => document.querySelectorAll(sel).length;
            const doc = document.documentElement;
            return {
                elements: document.getElementsByTagName("*").length,
                buttons: q("button, [role='button']"),
                links: q("a[href]"),
                images: q("img"),
                inputs: q("input, select, textarea"),
                headings: q("h1, h2, h3, h4, h5, h6"),
                scrollWidth: doc.scrollWidth,
                clientWidth: doc.clientWidth,
                scrollHeight: doc.scrollHeight
            };
        });
    } catch (err) {
        return { error: err.message };
    }
}

module.exports = {
    capture,
    // Exported so the external-page bridge (services/analyzePage.js) can reuse
    // the exact same browser-fact collection instead of duplicating it.
    summarizeAccessibility,
    summarizeDom
};
