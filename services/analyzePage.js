const path = require("path");

const { runValidators } = require("../validators");
const {
    summarizeAccessibility,
    summarizeDom
} = require("../playwright/capture");
const findingsEngine = require("./findingsEngine");
const analyzer = require("../ai/analyzer");
const { loadConfig } = require("./configLoader");
const {
    createScanFolder,
    createCombinationFolder,
    screenshotBaseName,
    toScanRelative
} = require("../utils/folder");
const { buildReport, writeJsonReport } = require("../reports/jsonReport");
const { writeHtmlReport } = require("../reports/htmlReport");

/**
 * Bridge: run our validators + AI verdict against a LIVE Playwright page that
 * an EXTERNAL test suite (e.g. a Percy/Playwright spec) has already navigated,
 * authenticated and put into the desired state.
 *
 * Unlike playwright/capture.js this does NOT launch a browser and does NOT
 * navigate — the caller owns the page lifecycle. It reuses every downstream
 * module (validators, accessibility/DOM summaries, findingsEngine, analyzer,
 * reports) so the verdict is identical to a native scan of the same state.
 *
 * @param {import('playwright').Page} page Live, already-navigated page.
 * @param {object} [options]
 * @param {object} [options.combination] Describes the state under test:
 *   { page: <stateName>, path?, url?, browser?, language?,
 *     viewport?: { name?, width, height } }.
 *   If `viewport` is omitted it is derived from `page.viewportSize()`.
 * @param {object} [options.config] Normalized config. Defaults to loadConfig().
 * @param {string} [options.scanFolder] Existing scan folder (absolute). Pass
 *   the same folder across calls so they share one scan/report. If omitted a
 *   fresh one is created (screenshots need somewhere to live).
 * @param {string[]} [options.imageRequestFailures] URLs of failed image
 *   requests the caller tracked (default []).
 * @param {string[]} [options.consoleErrors] Console errors the caller tracked.
 * @param {object[]} [options.failedRequests] Failed requests the caller tracked.
 * @param {string[]} [options.jsErrors] Uncaught JS errors the caller tracked.
 * @param {number} [options.loadTime] Measured load time in ms (default 0).
 * @returns {Promise<object>} Normalized combination result (same shape as a
 *   native scan result): status/confidence/needsHumanReview/findings/hints/ai.
 */
async function analyzePage(page, options = {}) {
    if (!page || typeof page.screenshot !== "function") {
        throw new Error(
            "analyzePage requires a live Playwright Page as its first argument"
        );
    }

    const config = options.config || loadConfig();
    const scanFolder = options.scanFolder || createScanFolder().folder;
    const imageRequestFailures = options.imageRequestFailures || [];

    const combination = normalizeCombination(options.combination, page);

    // a. Deterministic + hint validators (page-based, no navigation).
    const validators = await runValidators(page, {
        imageRequestFailures,
        config
    });

    // b. Objective browser facts (shared with playwright/capture.js).
    const accessibility = await summarizeAccessibility(page);
    const domSummary = await summarizeDom(page);

    // c. A single in-place screenshot of the current state (no scroll
    //    segmentation for the bridge — the caller controls what is visible).
    const outputFolder = createCombinationFolder(scanFolder, combination);
    const screenshotFile = path.join(
        outputFolder,
        `${screenshotBaseName(combination)}-01.png`
    );
    await page.screenshot({ path: screenshotFile });
    const screenshots = [
        {
            screen: 1,
            y: 0,
            file: screenshotFile,
            relative: toScanRelative(screenshotFile)
        }
    ];

    // d. Assemble the capture-like object findingsEngine expects. Runtime
    //    facts (console/js/network) are optional — the external caller may not
    //    have wired page listeners, so default to empty arrays.
    const capture = {
        title: await page.title().catch(() => ""),
        finalUrl: page.url(),
        loadTime: Number.isFinite(Number(options.loadTime))
            ? Number(options.loadTime)
            : 0,
        navError: null,
        consoleErrors: options.consoleErrors || [],
        failedRequests: options.failedRequests || [],
        jsErrors: options.jsErrors || [],
        accessibility,
        domSummary,
        screenshots,
        validators
    };

    // e. Split into facts vs hints and, only when there is something to
    //    confirm, run the AI verdict layer against the screenshot (mirrors
    //    services/scanner.js). Clean pages skip AI.
    const { authoritative, hints } = findingsEngine.classify(capture);

    let verdict = null;
    if (findingsEngine.shouldReview(capture)) {
        verdict = await analyzer.analyze(screenshotFile, {
            page: combination.page,
            browser: combination.browser,
            language: combination.language,
            viewport: combination.viewport,
            config,
            consoleErrors: capture.consoleErrors,
            failedRequests: capture.failedRequests,
            accessibility,
            domSummary,
            authoritativeFindings: authoritative.filter(
                f => f.status !== "PASS"
            ),
            hints: hints.filter(f => f.status !== "PASS")
        });
    }

    // f. Merge evidence into the final normalized result.
    return findingsEngine.buildResult(combination, capture, verdict);
}

/**
 * Fill in a combination with sensible defaults so folder creation and the
 * final result always have the fields they need.
 */
function normalizeCombination(raw, page) {
    const combination = raw || {};
    const derived =
        combination.viewport ||
        (typeof page.viewportSize === "function" && page.viewportSize()) ||
        {};

    return {
        page: combination.page || "Page",
        path: combination.path,
        url: combination.url || page.url(),
        browser: combination.browser || "chromium",
        language: combination.language || "en",
        viewport: {
            name: derived.name,
            width: Number(derived.width) || 0,
            height: Number(derived.height) || 0
        }
    };
}

/**
 * Emit our JSON + HTML report from a batch of results collected across one or
 * more analyzePage() calls that shared the same scanFolder. Lets an external
 * spec produce the standard Responsive QA report at the end of its run.
 *
 * @param {string} scanFolder Absolute scan folder (same one passed to
 *   analyzePage). Its basename is used as the scanId so inlined screenshot
 *   paths resolve correctly.
 * @param {object} [config] Normalized config. Defaults to loadConfig().
 * @param {object[]} results Results returned by analyzePage().
 * @param {object} [meta] Optional { startedAt, finishedAt } ISO timestamps.
 * @returns {{ report: object, summary: object, jsonPath: string,
 *   htmlPath: string, scanFolder: string, scanId: string }}
 */
function finalizeReport(scanFolder, config, results, meta = {}) {
    if (!scanFolder) {
        throw new Error("finalizeReport requires a scanFolder path");
    }

    const normalizedConfig = config || loadConfig();
    const scanResults = Array.isArray(results) ? results : [];

    const summary = findingsEngine.summarize(scanResults);
    const scanId = path.basename(scanFolder);
    const finishedAt = meta.finishedAt || new Date().toISOString();

    const report = buildReport({
        scanId,
        config: normalizedConfig,
        summary,
        results: scanResults,
        startedAt: meta.startedAt || null,
        finishedAt
    });

    const jsonPath = writeJsonReport(scanFolder, report);
    const htmlPath = writeHtmlReport(scanFolder, report);

    return { report, summary, jsonPath, htmlPath, scanFolder, scanId };
}

module.exports = {
    analyzePage,
    finalizeReport
};
