/**
 * Alignment validator (free, deterministic — no AI).
 *
 * Catches selection controls (checkboxes / radio buttons) that are stacked in a
 * vertical list but do NOT share a common left edge — e.g. a "Select All"
 * checkbox that sits a few pixels off from the row checkboxes below it.
 *
 * Kept deliberately conservative to avoid false positives (the whole system
 * treats a false positive as worse than a miss):
 *  - only compares controls of the SAME type and similar size,
 *  - needs a clear dominant column (most controls already share an edge),
 *  - only flags SMALL offsets (4–40px). Large offsets are almost always
 *    intentional nesting/indentation, so they are ignored.
 *  - reports as a WARNING, never a hard failure.
 */
const name = "alignment";
const tier = "authoritative";
const category = "Layout";

async function run(page) {
    const data = await page.evaluate(() => {
        const median = arr => {
            const a = [...arr].sort((x, y) => x - y);
            return a.length ? a[Math.floor(a.length / 2)] : 0;
        };
        const isVisible = el => {
            const s = getComputedStyle(el);
            if (s.visibility === "hidden" || s.display === "none" || s.opacity === "0") {
                return false;
            }
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        };

        const vh = window.innerHeight;
        const controls = [...document.querySelectorAll(
            "input[type=checkbox], input[type=radio], [role=checkbox], [role=radio]"
        )]
            .filter(isVisible)
            .map(el => {
                const r = el.getBoundingClientRect();
                return { left: r.left, top: r.top, w: r.width, bottom: r.bottom };
            })
            // Only controls actually visible in the viewport.
            .filter(c => c.top < vh && c.bottom > 0);

        if (controls.length < 3) return { misaligned: [], total: controls.length };

        // Compare only controls of similar width (same control, not a mix of
        // native + custom of different sizes).
        const medW = median(controls.map(c => c.w));
        const same = controls.filter(c => Math.abs(c.w - medW) <= Math.max(3, medW * 0.25));
        if (same.length < 3) return { misaligned: [], total: controls.length };

        const medLeft = median(same.map(c => c.left));
        const dev = same.map(c => ({ c, d: Math.abs(c.left - medLeft) }));
        const tight = dev.filter(x => x.d < 4);              // share the edge
        const outliers = dev.filter(x => x.d >= 4 && x.d <= 40); // small, likely a bug

        // Require a clear dominant column (>=60% share the edge) before trusting
        // that the outliers are actually wrong.
        if (outliers.length === 0 || tight.length < Math.ceil(same.length * 0.6)) {
            return { misaligned: [], total: same.length };
        }

        return {
            dominant: Math.round(medLeft),
            total: same.length,
            misaligned: outliers.map(x => Math.round(x.c.left - medLeft))
        };
    });

    if (!data.misaligned || data.misaligned.length === 0) {
        return [{
            status: "PASS",
            severity: "LOW",
            type: "ALIGNMENT",
            message: "Checkbox/radio controls share a consistent left edge"
        }];
    }

    const n = data.misaligned.length;
    const worst = Math.max(...data.misaligned.map(o => Math.abs(o)));
    const message = n === 1
        ? `A checkbox doesn't line up with the others (out by ${worst}px).`
        : `${n} checkboxes don't line up with each other (out by up to ${worst}px).`;
    return [{ status: "WARN", severity: "MEDIUM", type: "ALIGNMENT", message, data }];
}

module.exports = { name, run, tier, category };
