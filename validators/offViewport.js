/**
 * Off-viewport validator (free, deterministic — no AI).
 *
 * Catches INTERACTIVE controls (buttons, links, inputs) that are partly pushed
 * off the left/right edge of the screen — i.e. visible but cut off, so the user
 * can't see or use all of them. This is the "content jumping out of the window"
 * / "button cut off at the edge" class of responsive bug.
 *
 * Distinct from:
 *  - `overflow` (the whole PAGE is wider than the viewport / scrolls sideways),
 *  - `clipped` (an element cut by an inner container's overflow:hidden).
 * This one is about a control extending past the visible viewport edge.
 *
 * Conservative to avoid false positives:
 *  - interactive controls only (a cut-off button is almost always a real bug),
 *  - must be PARTLY visible (fully off-screen = intentionally hidden, skip),
 *  - skip controls inside a horizontal scroller (overflow-x auto/scroll) — that
 *    content is reachable by scrolling, so it's not "cut off",
 *  - skip position:fixed/sticky (they legitimately sit at edges),
 *  - only a MEANINGFUL cut (> 8px and > 15% of the control),
 *  - reports as a WARNING.
 */
const name = "offViewport";
const tier = "authoritative";
const category = "Layout";

async function run(page) {
    const data = await page.evaluate(() => {
        const vw = window.innerWidth;
        const SEL = "button, a[href], input, select, textarea, [role=button]";

        const noun = t =>
            ({ a: "link", button: "button", input: "field", select: "dropdown", textarea: "text box" }[t] || "control");
        const describe = el => {
            const t = (el.textContent || "").trim().slice(0, 24);
            return (t ? `"${t}" ` : "a ") + noun(el.tagName.toLowerCase());
        };

        const inHorizontalScroller = el => {
            let p = el.parentElement;
            while (p && p !== document.body) {
                const ox = getComputedStyle(p).overflowX;
                if (ox === "auto" || ox === "scroll") return true;
                p = p.parentElement;
            }
            return false;
        };
        // Skip anything pinned to the scroller (fixed/sticky self or ancestor):
        // it legitimately sits at edges and is not "cut off".
        const inPinnedRegion = el => {
            let p = el;
            while (p && p !== document.body && p !== document.documentElement) {
                const pos = getComputedStyle(p).position;
                if (pos === "fixed" || pos === "sticky") return true;
                p = p.parentElement;
            }
            return false;
        };

        const results = [];
        for (const el of document.querySelectorAll(SEL)) {
            const r = el.getBoundingClientRect();
            if (r.width < 2 || r.height < 2) continue;

            const cs = getComputedStyle(el);
            if (cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0") continue;
            if (inPinnedRegion(el)) continue;

            // Partly visible but cut by a side edge.
            const cutRight = r.right > vw ? Math.min(r.width, r.right - vw) : 0;
            const cutLeft = r.left < 0 ? Math.min(r.width, -r.left) : 0;
            const cut = Math.max(cutRight, cutLeft);
            const partlyVisible = r.left < vw && r.right > 0;

            if (partlyVisible && cut > 8 && cut / r.width > 0.15) {
                if (inHorizontalScroller(el)) continue;
                results.push(`${describe(el)} (${Math.round(cut)}px off the ${cutRight >= cutLeft ? "right" : "left"})`);
            }
            if (results.length >= 8) break;
        }
        return { count: results.length, samples: results.slice(0, 5), vw };
    });

    if (data.count === 0) {
        return [{
            status: "PASS",
            severity: "LOW",
            type: "OFF_VIEWPORT",
            message: "No interactive controls are cut off by the screen edge"
        }];
    }

    const message = data.count === 1
        ? `A button/link runs off the edge of the screen and is partly hidden: ${data.samples.join("; ")}.`
        : `${data.count} buttons/links run off the edge of the screen and are partly hidden: ${data.samples.join("; ")}.`;
    return [{ status: "WARN", severity: "MEDIUM", type: "OFF_VIEWPORT", message, data }];
}

module.exports = { name, run, tier, category };
