/**
 * EXAMPLE ONLY — illustrative snippet. Do NOT copy this file into the OQG-TS
 * repo; it lives here to document how an external Percy/Playwright suite would
 * call the AI Responsive QA bridge. Adapt the require path to wherever this
 * "UI Automation" platform is checked out relative to the OQG-TS spec.
 *
 * ------------------------------------------------------------------------
 * How this works
 * ------------------------------------------------------------------------
 * The bridge (services/analyzePage.js) is CommonJS JavaScript. From a
 * TypeScript spec running under ts-node / jiti / tsx you consume it with a
 * CommonJS `require(...)` (NOT `import`), so the TS -> JS boundary stays a
 * plain runtime require and no build step or type declarations are needed:
 *
 *     // TS spec (runtime) -> CommonJS bridge
 *     const { analyzePage, finalizeReport } =
 *         require("../../UI Automation/services/analyzePage");
 *     const { createScanFolder } = require("../../UI Automation/utils/folder");
 *
 * `analyzePage(page, opts)` runs OUR validators + AI verdict against the LIVE
 * page the spec already navigated/authenticated — it never launches a browser
 * or calls page.goto. AI is gated: it only runs when findingsEngine.shouldReview
 * says there is a fact/hint to confirm AND (for real OpenAI) config.ai.enabled
 * is true with OPENAI_API_KEY set; otherwise a cost-free mock verdict is used.
 *
 * `finalizeReport(scanFolder, config, results)` writes our standard
 * report.json + report.html once, at the end of the run.
 * ------------------------------------------------------------------------
 */

// The require() calls below are intentionally shown as runtime requires. When
// this snippet is embedded in a real .ts spec these are untyped `any`, which
// is fine for a bridge. Point the relative path at your UI Automation checkout.
/* eslint-disable @typescript-eslint/no-var-requires */

import { test, expect } from "@playwright/test";
// @ts-ignore percySnapshot is provided by @percy/playwright in the real suite
import percySnapshot from "@percy/playwright";

// TS (runtime) -> CommonJS bridge. Adjust the relative path for your repo.
const {
    analyzePage,
    finalizeReport
    // eslint-disable-next-line @typescript-eslint/no-var-requires
} = require("../../UI Automation/services/analyzePage");
const {
    createScanFolder
    // eslint-disable-next-line @typescript-eslint/no-var-requires
} = require("../../UI Automation/utils/folder");

// One shared scan folder so every viewport/state lands in the same report.
const { folder: scanFolder } = createScanFolder();
const qaResults: any[] = [];

// Example: the viewport matrix the OQG-TS suite already iterates.
const VIEWPORTS = [
    { name: "Mobile", width: 390, height: 844 },
    { name: "Tablet", width: 820, height: 1180 },
    { name: "Desktop", width: 1366, height: 768 }
];

test.describe("Event QR — Percy + AI Responsive QA", () => {
    for (const viewport of VIEWPORTS) {
        test(`event landing @ ${viewport.name}`, async ({ page }) => {
            await page.setViewportSize({
                width: viewport.width,
                height: viewport.height
            });

            // ... the suite's own navigation / auth / state setup ...
            await page.goto("https://oqg.dev.test-qr.com/event/demo");
            await expect(page.locator("main")).toBeVisible();

            // Existing Percy visual snapshot — unchanged.
            await percySnapshot(page, `Event landing — ${viewport.name}`);

            // >>> The one-line bridge call, right after percySnapshot: <<<
            qaResults.push(
                await analyzePage(page, {
                    combination: { page: `Event landing`, viewport },
                    scanFolder
                })
            );
        });
    }

    // Emit OUR JSON + HTML report once, after the whole run.
    test.afterAll(async () => {
        const { jsonPath, htmlPath } = finalizeReport(
            scanFolder,
            undefined, // undefined -> bridge calls loadConfig() for defaults
            qaResults
        );
        // eslint-disable-next-line no-console
        console.log(`AI Responsive QA report: ${htmlPath}\n(JSON: ${jsonPath})`);
    });
});
