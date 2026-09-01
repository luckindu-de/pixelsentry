const fs = require("fs");
const path = require("path");

/**
 * Build the report data object (also returned to API callers as JSON).
 */
function buildReport({ scanId, config, summary, results, startedAt, finishedAt }) {
    return {
        scanId,
        project: config.website,
        generatedAt: finishedAt || new Date().toISOString(),
        startedAt,
        finishedAt,
        config,
        summary,
        results
    };
}

/**
 * Persist the JSON report to scans/<timestamp>/report.json.
 * @returns {string} Absolute path to the written file.
 */
function writeJsonReport(scanFolder, report) {
    const filepath = path.join(scanFolder, "report.json");
    fs.writeFileSync(filepath, JSON.stringify(report, null, 2), "utf8");
    return filepath;
}

module.exports = {
    buildReport,
    writeJsonReport
};
