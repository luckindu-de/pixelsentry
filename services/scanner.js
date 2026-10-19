const { generateCombinations } = require("./combinationGenerator");
const { capture } = require("../playwright/capture");
const { login } = require("./auth");
const findingsEngine = require("./findingsEngine");
const analyzer = require("../ai/analyzer");
const { createScanFolder } = require("../utils/folder");
const { buildReport, writeJsonReport } = require("../reports/jsonReport");
const { writeHtmlReport } = require("../reports/htmlReport");
const jobStore = require("./jobStore");

/**
 * Orchestrate a full scan for a normalized config.
 *
 * Hybrid pipeline per combination:
 *   capture (browser facts + screenshots + tiered validators)
 *     -> findingsEngine.classify (authoritative facts vs DOM hints)
 *     -> ai.analyze (verdict layer; screenshot is source of truth)
 *     -> findingsEngine.buildResult (merge evidence -> status + confidence)
 *   ... then aggregate -> summary -> JSON + HTML reports.
 *
 * Progress is reported through jobStore so GET /scan/:id can poll it.
 *
 * @param {object} config Normalized config.
 * @param {object} [options]
 * @param {string} [options.jobId] Existing job id to update (for API mode).
 * @returns {Promise<object>} The full JSON report.
 */
async function runScan(config, options = {}) {
    const combinations = generateCombinations(config);
    const { id: scanId, folder: scanFolder } = createScanFolder();

    const jobId = options.jobId;
    if (jobId) {
        jobStore.updateJob(jobId, {
            status: "running",
            total: combinations.length,
            scanFolder
        });
    }

    const startedAt = new Date().toISOString();
    const results = [];

    // Log in once (via the site form) so authenticated pages — dashboards,
    // funnels, create/generate — load logged-in. Falls back to unauthenticated
    // when no credentials are set in .env.
    let storageState = null;
    try {
        const auth = await login(config.website, config);
        if (auth && auth.ok) storageState = auth.storageState;
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`Login step failed: ${err.message}`);
    }

    for (const combination of combinations) {
        let result;
        try {
            const captureResult = await capture({
                scanFolder,
                combination,
                config,
                storageState
            });

            // Split signals into trusted facts and DOM hints.
            const { authoritative, hints } = findingsEngine.classify(
                captureResult
            );

            // AI vision acts as the verdict layer. Only invoke it when there
            // is something to confirm (an authoritative issue or a hint).
            let verdict = null;
            if (findingsEngine.shouldReview(captureResult)) {
                const primary =
                    captureResult.screenshots &&
                    captureResult.screenshots[0] &&
                    captureResult.screenshots[0].file;
                verdict = await analyzer.analyze(primary, {
                    page: combination.page,
                    browser: combination.browser,
                    language: combination.language,
                    viewport: combination.viewport,
                    config,
                    consoleErrors: captureResult.consoleErrors,
                    failedRequests: captureResult.failedRequests,
                    accessibility: captureResult.accessibility,
                    domSummary: captureResult.domSummary,
                    authoritativeFindings: authoritative.filter(
                        f => f.status !== "PASS"
                    ),
                    hints: hints.filter(f => f.status !== "PASS")
                });
            }

            result = findingsEngine.buildResult(
                combination,
                captureResult,
                verdict
            );
        } catch (err) {
            // A single combination failing should not abort the scan.
            result = {
                page: combination.page,
                path: combination.path,
                url: combination.url,
                browser: combination.browser,
                language: combination.language,
                viewport: combination.viewport,
                status: "FAIL",
                confidence: 100,
                needsHumanReview: false,
                screenshot: null,
                screenshots: [],
                title: "",
                finalUrl: combination.url,
                loadTime: 0,
                consoleErrors: [],
                failedRequests: [],
                jsErrors: [],
                accessibility: {},
                domSummary: {},
                findings: [
                    {
                        source: "system",
                        tier: "authoritative",
                        status: "FAIL",
                        severity: "HIGH",
                        category: "Layout",
                        type: "CAPTURE_ERROR",
                        message: `Failed to scan combination: ${err.message}`,
                        confidence: 100
                    }
                ],
                hints: [],
                ai: null,
                passedChecks: []
            };
        }

        results.push(result);

        if (jobId) {
            jobStore.updateJob(jobId, { completed: results.length });
        }
    }

    const summary = findingsEngine.summarize(results);
    const finishedAt = new Date().toISOString();

    const report = buildReport({
        scanId,
        config,
        summary,
        results,
        startedAt,
        finishedAt
    });

    writeJsonReport(scanFolder, report);
    const reportHtmlPath = writeHtmlReport(scanFolder, report);

    if (jobId) {
        jobStore.updateJob(jobId, {
            status: "done",
            completed: results.length,
            finishedAt,
            summary,
            report,
            reportHtmlPath
        });
    }

    return { ...report, scanFolder, reportHtmlPath };
}

module.exports = {
    runScan
};
