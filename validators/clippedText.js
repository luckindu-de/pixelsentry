/**
 * Clipped-text validator (free, deterministic — no AI).
 *
 * Catches text that is HARD-clipped inside its own box: the element has
 * `overflow: hidden`/`clip` and its content is taller/wider than the box
 * (`scrollHeight`/`scrollWidth` exceeds `clientHeight`/`clientWidth`) — so the
 * user sees text that is simply cut off, with no "…" to signal it. This is the
 * most common real "cropping" bug and the geometric checks (which look at
 * element rects) miss it, because the element's own box is fine — it's the
 * CONTENT inside that overflows.
 *
 * High-precision by design (avoids the intentional-truncation false positives):
 *  - SKIP `text-overflow: ellipsis` and `-webkit-line-clamp` — those are
 *    deliberate truncation affordances, handled separately as a soft hint.
 *  - SKIP scroll containers (only `hidden`/`clip` clip permanently).
 *  - SKIP fixed/sticky (pinned) regions.
 *  - require a MEANINGFUL cut (> 8px) and a real-sized box.
 *  - reports as a WARNING.
 */
const name = "clippedText";
const tier = "authoritative";
const category = "Text";

async function run(page) {
    const data = await page.evaluate(() => {
        const inPinnedRegion = el => {
            let p = el;
            while (p && p !== document.body && p !== document.documentElement) {
                const pos = getComputedStyle(p).position;
                if (pos === "fixed" || pos === "sticky") return true;
                p = p.parentElement;
            }
            return false;
        };
        const describe = el => {
            const t = (el.textContent || "").trim().slice(0, 32);
            return t ? `"${t}"` : `<${el.tagName.toLowerCase()}>`;
        };

        const results = [];
        const nodes = document.body ? document.body.querySelectorAll("*") : [];
        for (const el of nodes) {
            const text = (el.textContent || "").trim();
            if (text.length < 2) continue;
            // Leaf-ish only, so we blame the actual text box, not a wrapper.
            if (el.children.length > 3) continue;

            const s = getComputedStyle(el);
            if (s.display === "none" || s.visibility === "hidden" || parseFloat(s.opacity) === 0) continue;

            const clipX = s.overflowX === "hidden" || s.overflowX === "clip";
            const clipY = s.overflowY === "hidden" || s.overflowY === "clip";
            if (!clipX && !clipY) continue;

            // Intentional truncation affordances — not a bug, handled elsewhere.
            if (s.textOverflow === "ellipsis") continue;
            const clamp = s.webkitLineClamp || s.getPropertyValue("-webkit-line-clamp");
            if (clamp && clamp !== "none") continue;

            if (inPinnedRegion(el)) continue;

            const cutX = clipX && el.clientWidth > 0 ? el.scrollWidth - el.clientWidth : 0;
            const cutY = clipY && el.clientHeight > 0 ? el.scrollHeight - el.clientHeight : 0;
            const cut = Math.max(cutX, cutY);
            if (cut <= 8) continue;

            const r = el.getBoundingClientRect();
            if (r.width < 8 || r.height < 8) continue;

            results.push(`${describe(el)} (~${Math.round(cut)}px hidden)`);
            if (results.length >= 8) break;
        }
        return { count: results.length, samples: results.slice(0, 5) };
    });

    if (data.count === 0) {
        return [{
            status: "PASS",
            severity: "LOW",
            type: "CLIPPED_TEXT",
            message: "No text is hard-clipped inside its box"
        }];
    }

    const message = data.count === 1
        ? `Text is cut off inside its box with no "…" shown, so content looks missing: ${data.samples.join("; ")}.`
        : `${data.count} places have text cut off inside their box with no "…" (content looks missing): ${data.samples.join("; ")}.`;
    return [{ status: "WARN", severity: "MEDIUM", type: "CLIPPED_TEXT", message, data }];
}

module.exports = { name, run, tier, category };
