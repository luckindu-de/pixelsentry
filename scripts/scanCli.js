/**
 * CLI runner: run a scan directly from the terminal without the API server.
 *
 *   node scripts/scanCli.js                 # uses config/project.json
 *   node scripts/scanCli.js path/to/cfg.json
 *
 * Prints the summary and the paths to the generated reports.
 */
require("dotenv").config();

const fs = require("fs");
const { loadConfig } = require("../services/configLoader");
const { runScan } = require("../services/scanner");
const { generateCombinations } = require("../services/combinationGenerator");

// Guard against accidentally launching a many-thousand-combination run (the
// full pages x browsers x languages x viewports matrix). Override with
// `--force` or SCAN_FORCE=1, or raise the ceiling with SCAN_LIMIT.
const DEFAULT_LIMIT = 500;

async function main() {
    const args = process.argv.slice(2);
    const force = args.includes("--force") || process.env.SCAN_FORCE === "1";
    const customPath = args.find(a => !a.startsWith("--"));

    let config;
    if (customPath) {
        const raw = JSON.parse(fs.readFileSync(customPath, "utf8"));
        config = loadConfig(raw);
    } else {
        config = loadConfig();
    }

    const combinations = generateCombinations(config);
    const limit = Number(process.env.SCAN_LIMIT) || DEFAULT_LIMIT;

    console.log(
        `Matrix: ${config.pages.length} page(s) x ${config.browsers.length} ` +
        `browser(s) x ${config.languages.length} language(s) x ` +
        `${config.viewports.length} viewport(s) = ${combinations.length} ` +
        `combination(s).`
    );

    if (combinations.length > limit && !force) {
        console.error(
            `\nThis run would produce ${combinations.length} combinations ` +
            `(> ${limit}). That can take many hours and a lot of disk.\n` +
            "Trim languages/viewports in config/project.json, or re-run with " +
            "--force (or SCAN_FORCE=1) to proceed anyway. You can also raise " +
            "the ceiling with SCAN_LIMIT=<n>."
        );
        process.exit(1);
    }

    console.log(`\nScanning ${config.website} ...`);
    const report = await runScan(config);

    console.log("\nSummary:", JSON.stringify(report.summary, null, 2));
    console.log("\nJSON report:", `${report.scanFolder}\\report.json`);
    console.log("HTML report:", report.reportHtmlPath);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
