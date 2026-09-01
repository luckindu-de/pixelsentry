/**
 * Findings engine (hybrid).
 *
 * Splits raw signals into two tiers:
 *   - authoritative: deterministic facts (contrast math, broken images,
 *     horizontal overflow, real clickability, console/JS/network errors).
 *     These directly set the deterministic verdict.
 *   - hints: DOM-geometry heuristics (hidden/overlap/text overflow) that are
 *     frequently false positives. They never fail on their own; they are
 *     forwarded to AI vision to be confirmed or dismissed against the
 *     screenshot.
 *
 * Then it MERGES the deterministic verdict with the AI visual verdict into a
 * final status + confidence, flagging disagreements for human review.
 */

const STATUS_RANK = { PASS: 0, WARN: 1, FAIL: 2 };

function worseStatus(a, b) {
    return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

function aiStatusToInternal(overallStatus) {
    if (overallStatus === "FAIL") return "FAIL";
    if (overallStatus === "WARNING") return "WARN";
    return "PASS";
}

/**
 * Classify a capture into authoritative findings and hints.
 * Runtime signals (console/JS/network errors) are objective => authoritative.
 *
 * @returns {{ authoritative: object[], hints: object[] }}
 */
function classify(capture) {
    const validatorFindings = (capture.validators || []).map(f => ({
        source: "validator",
        ...f
    }));

    const runtime = buildRuntimeFindings(capture).map(f => ({
        source: "runtime",
        tier: "authoritative",
        ...f
    }));

    const authoritative = [
        ...validatorFindings.filter(f => f.tier === "authoritative"),
        ...runtime
    ];
    const hints = validatorFindings.filter(f => f.tier === "hint");

    return { authoritative, hints };
}

/**
 * Build the final normalized combination result by merging deterministic
 * facts with the AI verdict.
 *
 * @param {object} combination
 * @param {object} capture
 * @param {object} verdict AI verdict { overallStatus, confidence, issues[], source }
 * @returns {object}
 */
function buildResult(combination, capture, verdict) {
    const { authoritative, hints } = classify(capture);

    const authoritativeStatus = statusOf(authoritative);
    const aiStatus = verdict ? aiStatusToInternal(verdict.overallStatus) : "PASS";

    const finalStatus = worseStatus(authoritativeStatus, aiStatus);

    const merged = mergeConfidence({
        authoritativeStatus,
        aiStatus,
        finalStatus,
        verdict
    });

    // Real, counted issues = authoritative (non-pass) + AI issues.
    const authIssues = authoritative
        .filter(f => f.status !== "PASS")
        .map(f => ({
            source: f.source || "validator",
            tier: "authoritative",
            status: f.status,
            severity: f.severity,
            category: f.category || "Layout",
            type: f.type,
            message: f.message,
            confidence: 100
        }));

    const aiIssues = (verdict ? verdict.issues : []).map(issue => ({
        source: "ai",
        tier: "ai",
        status: severityToStatus(issue.severity),
        severity: issue.severity,
        category: issue.category,
        type: issue.category ? issue.category.toUpperCase() : "AI_VISION",
        message: issue.title
            ? `${issue.title}: ${issue.description}`
            : issue.description,
        location: issue.location,
        recommendation: issue.recommendation,
        confidence: issue.confidence
    }));

    const primaryScreenshot =
        capture.screenshots && capture.screenshots.length
            ? capture.screenshots[0].relative
            : null;

    return {
        page: combination.page,
        path: combination.path,
        url: combination.url,
        browser: combination.browser,
        language: combination.language,
        viewport: combination.viewport,

        status: finalStatus,
        confidence: merged.confidence,
        needsHumanReview: merged.needsHumanReview,

        // Backward-compat single screenshot alias.
        screenshot: primaryScreenshot,
        screenshots: capture.screenshots || [],
        title: capture.title,
        finalUrl: capture.finalUrl,
        loadTime: capture.loadTime,
        consoleErrors: capture.consoleErrors || [],
        failedRequests: capture.failedRequests || [],
        jsErrors: capture.jsErrors || [],
        accessibility: capture.accessibility || {},
        domSummary: capture.domSummary || {},

        // Counted issues.
        findings: [...authIssues, ...aiIssues],
        // DOM heuristics, shown for transparency but NOT counted.
        hints: hints
            .filter(f => f.status !== "PASS")
            .map(f => ({
                type: f.type,
                category: f.category,
                message: f.message,
                note: "DOM hint - not counted (verify visually)"
            })),

        ai: verdict
            ? {
                  status: verdict.overallStatus,
                  confidence: verdict.confidence,
                  source: verdict.source,
                  issues: verdict.issues
              }
            : null,

        passedChecks: authoritative.filter(f => f.status === "PASS")
    };
}

function statusOf(findings) {
    let s = "PASS";
    for (const f of findings) s = worseStatus(s, f.status);
    return s;
}

function severityToStatus(sev) {
    const up = String(sev).toUpperCase();
    if (up === "CRITICAL" || up === "HIGH") return "FAIL";
    if (up === "MEDIUM") return "WARN";
    return "WARN";
}

/**
 * Confidence + human-review flag from the agreement between the two verdicts.
 */
function mergeConfidence({ authoritativeStatus, aiStatus, finalStatus, verdict }) {
    const aiConf = verdict ? verdict.confidence : 0;

    // Final status driven by an authoritative fact => high confidence.
    if (finalStatus !== "PASS" && authoritativeStatus === finalStatus) {
        return { confidence: 92, needsHumanReview: false };
    }

    // Final status driven only by AI (screenshot-based) => trust AI's own
    // confidence and flag for review when it is not confident.
    if (finalStatus !== "PASS" && aiStatus === finalStatus) {
        return {
            confidence: aiConf,
            needsHumanReview: aiConf < 70
        };
    }

    // Both agree it's fine.
    if (authoritativeStatus === "PASS" && aiStatus === "PASS") {
        // If the AI could not actually see the page (mock/low conf) keep it
        // modest so nobody over-trusts a clean bill of health.
        return {
            confidence: Math.max(aiConf, 50),
            needsHumanReview: aiConf < 40
        };
    }

    return { confidence: aiConf, needsHumanReview: true };
}

function buildRuntimeFindings(capture) {
    const findings = [];

    if (capture.navError) {
        findings.push({
            status: "FAIL",
            severity: "HIGH",
            type: "NAVIGATION",
            category: "Layout",
            message: `Page did not load correctly: ${capture.navError}`
        });
    }

    if (capture.jsErrors && capture.jsErrors.length) {
        findings.push({
            status: "FAIL",
            severity: "HIGH",
            type: "JS_ERROR",
            category: "Interaction",
            message:
                `The page hit ${capture.jsErrors.length} JavaScript error(s), which can ` +
                `break features on the page.`
        });
    }

    if (capture.consoleErrors && capture.consoleErrors.length) {
        findings.push({
            status: "WARN",
            severity: "MEDIUM",
            type: "CONSOLE_ERROR",
            category: "Interaction",
            message:
                `${capture.consoleErrors.length} error(s) showed up in the browser ` +
                `console — worth a developer's look.`
        });
    }

    if (capture.failedRequests && capture.failedRequests.length) {
        findings.push({
            status: "WARN",
            severity: "MEDIUM",
            type: "NETWORK_ERROR",
            category: "Image",
            message:
                `${capture.failedRequests.length} file(s) failed to load (images, scripts, ` +
                `or styles) — some content may be missing or unstyled.`
        });
    }

    return findings;
}

/**
 * Aggregate combination results into a scan summary.
 */
function summarize(results) {
    const summary = {
        total: results.length,
        passed: 0,
        warnings: 0,
        failed: 0,
        needsHumanReview: 0,
        byType: {}
    };

    for (const r of results) {
        if (r.status === "FAIL") summary.failed++;
        else if (r.status === "WARN") summary.warnings++;
        else summary.passed++;

        if (r.needsHumanReview) summary.needsHumanReview++;

        for (const f of r.findings) {
            summary.byType[f.type] = (summary.byType[f.type] || 0) + 1;
        }
    }

    return summary;
}

/**
 * Whether a capture warrants AI vision. We always want AI for anything with
 * either an authoritative issue OR any hint (hints are exactly the cases only
 * a screenshot can confirm). Clean pages with no signals can skip AI.
 */
function shouldReview(capture) {
    const { authoritative, hints } = classify(capture);
    return (
        hints.some(f => f.status !== "PASS") ||
        authoritative.some(f => f.status !== "PASS")
    );
}

module.exports = {
    classify,
    buildResult,
    summarize,
    shouldReview,
    worseStatus
};
