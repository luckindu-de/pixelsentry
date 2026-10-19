/**
 * Clipped-by-container validator (free, deterministic — no AI).
 *
 * Catches INTERACTIVE controls / pop-ups (buttons, links, menu items, open
 * dropdowns, dialogs) that are partially cut off because an ancestor container
 * has `overflow: hidden` (or `clip`) and the control extends beyond it — e.g. a
 * "Save" button or a dropdown menu sliced by the edge of its card.
 *
 * Conservative to avoid false positives:
 *  - only `hidden`/`clip` count as clipping. `auto`/`scroll` do NOT — that
 *    content is still reachable by scrolling, so it is not "cut off".
 *  - `position: fixed`/`sticky` elements escape ancestor clipping, so skip them.
 *  - only flags a MEANINGFUL cut: more than 8px AND more than 15% of the element
 *    on an axis the parent actually clips.
 *  - reports as a WARNING (verify), not a hard failure.
 *
 * Note: dropdown menus are only caught if they are actually OPEN in the captured
 * page state.
 */
const name = "clipped";
const tier = "authoritative";
const category = "Layout";

async function run(page) {
    const data = await page.evaluate(() => {
        const SEL =
            "button, [role=button], a[href], [role=menuitem], [role=option], " +
            "[role=menu], [role=listbox], [role=dialog]";

        const noun = t =>
            ({ a: "link", button: "button", input: "field", select: "dropdown", textarea: "text box" }[t] || "control");
        const describe = el => {
            const t = (el.textContent || "").trim().slice(0, 24);
            return (t ? `"${t}" ` : "the ") + noun(el.tagName.toLowerCase());
        };
        // A fixed/sticky element (or anything inside one) is pinned to the
        // scroller and legitimately sits at edges / overlays scrolling content,
        // so ancestor-rect clipping math produces false positives. Skip them.
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
            if (cs.visibility === "hidden" || cs.display === "none") continue;
            // Fixed/sticky elements and their descendants escape ancestor
            // clipping, so comparing rects would produce false positives.
            if (inPinnedRegion(el)) continue;

            let p = el.parentElement;
            while (p && p !== document.body && p !== document.documentElement) {
                const ps = getComputedStyle(p);
                const clipsX = ps.overflowX === "hidden" || ps.overflowX === "clip";
                const clipsY = ps.overflowY === "hidden" || ps.overflowY === "clip";

                if (clipsX || clipsY) {
                    const pr = p.getBoundingClientRect();
                    const cutX = clipsX
                        ? Math.max(0, r.right - pr.right, pr.left - r.left)
                        : 0;
                    const cutY = clipsY
                        ? Math.max(0, r.bottom - pr.bottom, pr.top - r.top)
                        : 0;
                    const meaningful =
                        (cutX > 8 && cutX / r.width > 0.15) ||
                        (cutY > 8 && cutY / r.height > 0.15);
                    if (meaningful) {
                        results.push(
                            `${describe(el)} (~${Math.round(Math.max(cutX, cutY))}px hidden)`
                        );
                        break;
                    }
                }
                p = p.parentElement;
            }
            if (results.length >= 8) break;
        }

        return { count: results.length, samples: results.slice(0, 5) };
    });

    if (data.count === 0) {
        return [{
            status: "PASS",
            severity: "LOW",
            type: "CLIPPED",
            message: "No interactive controls are cut off by a container"
        }];
    }

    const message = data.count === 1
        ? `A button/link is partly cut off by the edge of its box: ${data.samples.join("; ")}.`
        : `${data.count} buttons/links are partly cut off by the edge of their box: ${data.samples.join("; ")}.`;
    return [{ status: "WARN", severity: "MEDIUM", type: "CLIPPED", message, data }];
}

module.exports = { name, run, tier, category };
