/**
 * Overlap Detection validator.
 *
 * Detects interactive elements (links/buttons/inputs) that are covered by
 * another element at their center point. We use elementFromPoint at each
 * candidate's center: if the topmost element there is not the candidate
 * (nor a descendant/ancestor of it), the candidate is likely obscured -
 * e.g. a Subscribe button hidden behind a sticky footer.
 */
const name = "overlap";

async function run(page) {
    const data = await page.evaluate(() => {
        const CANDIDATES = "a, button, input, select, textarea, [role='button']";
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        const describe = el =>
            `<${el.tagName.toLowerCase()}${el.id ? ` id="${el.id}"` : ""}>` +
            (el.textContent ? ` "${el.textContent.trim().slice(0, 30)}"` : "");

        const overlaps = [];

        for (const el of document.querySelectorAll(CANDIDATES)) {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;

            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;

            // Only test points currently within the viewport bounds.
            if (cx < 0 || cy < 0 || cx > vw || cy > vh) continue;

            const topEl = document.elementFromPoint(cx, cy);
            if (!topEl) continue;

            const related =
                topEl === el || el.contains(topEl) || topEl.contains(el);

            if (!related) {
                overlaps.push(
                    `${describe(el)} covered by ${describe(topEl)}`
                );
            }
            if (overlaps.length >= 8) break;
        }

        return { count: overlaps.length, samples: overlaps.slice(0, 5) };
    });

    if (data.count === 0) {
        return [
            {
                status: "PASS",
                severity: "LOW",
                type: "OVERLAP",
                message: "No interactive elements appear to be covered"
            }
        ];
    }

    return [
        {
            status: "FAIL",
            severity: "HIGH",
            type: "OVERLAP",
            message:
                `${data.count} interactive element(s) appear covered by ` +
                `another element. Examples: ${data.samples.join("; ")}`,
            data
        }
    ];
}

// elementFromPoint overlap is unreliable (transforms, stacking contexts,
// pointer-events, animations). Real actionability is tested by clickability.
// So overlap is a HINT only.
const tier = "hint";
const category = "Interaction";

module.exports = { name, run, tier, category };
