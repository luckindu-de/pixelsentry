/**
 * Hidden Elements validator.
 *
 * Flags elements that carry meaningful content but are invisible or
 * positioned outside the viewport. We only consider "interesting" elements
 * (links, buttons, inputs, headings, images, elements with text) to avoid
 * noise from intentionally hidden wrappers, scripts, etc.
 */
const name = "hiddenElements";

async function run(page) {
    const data = await page.evaluate(() => {
        const INTERESTING = new Set([
            "A", "BUTTON", "INPUT", "SELECT", "TEXTAREA",
            "IMG", "H1", "H2", "H3", "LABEL"
        ]);

        const results = {
            displayNone: 0,
            visibilityHidden: 0,
            opacityZero: 0,
            zeroSize: 0,
            offscreen: 0,
            samples: []
        };

        const describe = el =>
            `<${el.tagName.toLowerCase()}${el.id ? ` id="${el.id}"` : ""}>` +
            (el.textContent ? ` "${el.textContent.trim().slice(0, 40)}"` : "");

        const vw = window.innerWidth;
        const vh = window.innerHeight;

        const nodes = document.body
            ? document.body.querySelectorAll("*")
            : [];

        for (const el of nodes) {
            const isInteresting =
                INTERESTING.has(el.tagName) ||
                (el.textContent && el.textContent.trim().length > 0 &&
                    el.children.length === 0);
            if (!isInteresting) continue;

            const style = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            let flagged = null;

            if (style.display === "none") {
                results.displayNone++;
                flagged = "display:none";
            } else if (style.visibility === "hidden") {
                results.visibilityHidden++;
                flagged = "visibility:hidden";
            } else if (parseFloat(style.opacity) === 0) {
                results.opacityZero++;
                flagged = "opacity:0";
            } else if (
                (rect.width === 0 || rect.height === 0) &&
                (el.textContent || "").trim().length > 0
            ) {
                results.zeroSize++;
                flagged = "zero size";
            } else if (
                rect.width > 0 &&
                rect.height > 0 &&
                (rect.right <= 0 ||
                    rect.bottom <= 0 ||
                    rect.left >= vw ||
                    rect.top >= vh + document.documentElement.scrollHeight)
            ) {
                // Fully outside the scrollable document, not just below fold.
                results.offscreen++;
                flagged = "offscreen";
            }

            if (flagged && results.samples.length < 8) {
                results.samples.push(`${flagged}: ${describe(el)}`);
            }
        }

        return results;
    });

    const findings = [];

    const total =
        data.displayNone +
        data.visibilityHidden +
        data.opacityZero +
        data.zeroSize +
        data.offscreen;

    // display:none is extremely common and legitimate (menus, tabs), so on
    // its own it is only informational. The other categories are stronger
    // signals of a responsive defect.
    const suspicious =
        data.visibilityHidden +
        data.opacityZero +
        data.zeroSize +
        data.offscreen;

    if (suspicious === 0) {
        findings.push({
            status: "PASS",
            severity: "LOW",
            type: "HIDDEN_ELEMENT",
            message: "No suspicious hidden content elements detected"
        });
        return findings;
    }

    findings.push({
        status: "WARN",
        severity: "MEDIUM",
        type: "HIDDEN_ELEMENT",
        message:
            `${suspicious} content element(s) are effectively hidden ` +
            `(zero-size/offscreen/invisible). Samples: ` +
            data.samples.slice(0, 4).join("; "),
        data: { total, ...data }
    });

    return findings;
}

// DOM-only hidden detection is prone to false positives (intentional
// responsive hiding, a11y helpers, offscreen templates), so it is a HINT.
const tier = "hint";
const category = "Layout";

module.exports = { name, run, tier, category };
