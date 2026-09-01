/**
 * Validator plugin engine.
 *
 * Each validator is a module exporting:
 *   { name, tier, category, run(page, context) }
 * where run resolves to an array of findings:
 *   { status: "PASS"|"WARN"|"FAIL", severity: "HIGH"|"MEDIUM"|"LOW",
 *     type: string, message: string, data?: object }
 *
 * `tier` classifies how much the finding should be trusted:
 *   - "authoritative": deterministic, reliable -> may set the verdict
 *     (contrast, clickability, broken images, horizontal overflow).
 *   - "hint": DOM-geometry heuristic, prone to false positives -> passed to
 *     AI vision as a hint only, never fails on its own
 *     (hiddenElements, overlap, textOverflow).
 *
 * To add a validator, drop a module in this folder and register it below.
 * Each validator is isolated: a crash is caught and surfaced as a WARN.
 */
const overflow = require("./overflow");
const hiddenElements = require("./hiddenElements");
const overlap = require("./overlap");
const brokenImages = require("./brokenImages");
const textOverflow = require("./textOverflow");
const contrast = require("./contrast");
const clickability = require("./clickability");
const alignment = require("./alignment");
const clipped = require("./clipped");
const offViewport = require("./offViewport");

const PLUGINS = [
    overflow,
    brokenImages,
    contrast,
    clickability,
    alignment,
    clipped,
    offViewport,
    hiddenElements,
    overlap,
    textOverflow
];

/**
 * Run every registered validator against a page.
 *
 * @param {import('playwright').Page} page
 * @param {object} [context] Extra signals (imageRequestFailures, config).
 * @returns {Promise<Array<object>>} Flat array of findings, each tagged with
 *   its validator name, tier and category.
 */
async function runValidators(page, context = {}) {
    const all = [];

    for (const plugin of PLUGINS) {
        const tier = plugin.tier || "hint";
        const category = plugin.category || "Layout";
        try {
            const findings = await plugin.run(page, context);
            for (const f of findings) {
                all.push({ validator: plugin.name, tier, category, ...f });
            }
        } catch (err) {
            all.push({
                validator: plugin.name,
                tier: "hint",
                category,
                status: "WARN",
                severity: "LOW",
                type: "VALIDATOR_ERROR",
                message: `Validator "${plugin.name}" failed: ${err.message}`
            });
        }
    }

    return all;
}

module.exports = {
    runValidators,
    PLUGINS
};
