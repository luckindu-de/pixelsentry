const path = require("path");
const { toScanRelative } = require("../utils/folder");

/**
 * Capture viewport-sized screenshots down the length of the page.
 *
 * Instead of a single full-page screenshot, we scroll one viewport at a
 * time and snapshot the visible area. This mirrors what a user actually
 * sees on a device and keeps individual images small enough for AI vision.
 *
 * @param {import('playwright').Page} page
 * @param {string} outputFolder Absolute folder for this combination.
 * @param {string} [baseName] Descriptive file stem, e.g.
 *   "home-1024x768-chrome-en". Each screen is saved as
 *   "<baseName>-01.png", "<baseName>-02.png", ... . Falls back to "screen".
 * @returns {Promise<Array<{screen:number,y:number,file:string,relative:string}>>}
 */
async function segmentedCapture(page, outputFolder, baseName = "screen") {
    // Stabilize the page before capturing so screenshots are not taken while an
    // animation/transition is mid-flight (a common cause of a button appearing
    // half-rendered/cut). Kill animations + transitions, force instant scroll,
    // hide the text caret, then settle at the top.
    await page
        .addStyleTag({
            content:
                "*,*::before,*::after{animation-duration:0s!important;" +
                "animation-delay:0s!important;transition-duration:0s!important;" +
                "transition-delay:0s!important;scroll-behavior:auto!important;" +
                "caret-color:transparent!important}"
        })
        .catch(() => {});
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await page.waitForTimeout(300);

    const pageHeight = await page.evaluate(
        () => document.documentElement.scrollHeight
    );

    const viewport = page.viewportSize() || { width: 0, height: 0 };
    const step = Math.max(viewport.height, 1);

    const fileFor = index =>
        path.join(outputFolder, `${baseName}-${String(index).padStart(2, "0")}.png`);

    const screenshots = [];
    let index = 1;

    for (let y = 0; y < pageHeight; y += step) {
        await page.evaluate(scrollY => window.scrollTo(0, scrollY), y);
        await page.waitForTimeout(250);

        const filepath = fileFor(index);
        await page.screenshot({ path: filepath });

        screenshots.push({
            screen: index,
            y,
            file: filepath,
            relative: toScanRelative(filepath)
        });

        index++;
    }

    // Always guarantee at least one screenshot (very short pages).
    if (screenshots.length === 0) {
        const filepath = fileFor(1);
        await page.screenshot({ path: filepath });
        screenshots.push({
            screen: 1,
            y: 0,
            file: filepath,
            relative: toScanRelative(filepath)
        });
    }

    return screenshots;
}

module.exports = {
    segmentedCapture
};
