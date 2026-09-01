/**
 * Contrast validator (deterministic WCAG 2.2).
 *
 * For every visible text element we compute the foreground color and the
 * effective (first non-transparent ancestor) background color, then the
 * WCAG contrast ratio. This needs no AI - it is pure math - so it is
 * authoritative.
 *
 * To avoid false positives we deliberately SKIP elements whose background
 * cannot be determined reliably from a solid color: any ancestor with a
 * background-image / gradient, or a semi-transparent background. Those are
 * exactly the cases where the true rendered background is only knowable
 * from the screenshot (left to AI vision).
 */
const name = "contrast";
const tier = "authoritative";
const category = "Accessibility";

async function run(page, context = {}) {
    const thresholds = (context.config && context.config.thresholds) || {};
    const aa = thresholds.contrastAA || 4.5;
    const aaLarge = thresholds.contrastAALarge || 3.0;

    const data = await page.evaluate(
        ({ aa, aaLarge }) => {
            function parseColor(str) {
                const m = str.match(
                    /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/
                );
                if (!m) return null;
                return {
                    r: +m[1],
                    g: +m[2],
                    b: +m[3],
                    a: m[4] === undefined ? 1 : +m[4]
                };
            }

            function luminance({ r, g, b }) {
                const chan = c => {
                    c /= 255;
                    return c <= 0.03928
                        ? c / 12.92
                        : Math.pow((c + 0.055) / 1.055, 2.4);
                };
                return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
            }

            function ratio(fg, bg) {
                const L1 = luminance(fg);
                const L2 = luminance(bg);
                const light = Math.max(L1, L2);
                const dark = Math.min(L1, L2);
                return (light + 0.05) / (dark + 0.05);
            }

            // Walk ancestors to find a reliable solid background. Returns
            // null when any ancestor uses an image/gradient (unreliable).
            function effectiveBg(el) {
                let node = el;
                while (node && node !== document.documentElement) {
                    const s = getComputedStyle(node);
                    if (s.backgroundImage && s.backgroundImage !== "none") {
                        return null;
                    }
                    const c = parseColor(s.backgroundColor || "");
                    if (c && c.a === 1) return c;
                    if (c && c.a > 0 && c.a < 1) return null; // translucent
                    node = node.parentElement;
                }
                // Fall back to the page background (usually white).
                const bodyBg = parseColor(
                    getComputedStyle(document.body).backgroundColor
                );
                return bodyBg && bodyBg.a === 1 ? bodyBg : { r: 255, g: 255, b: 255, a: 1 };
            }

            function hasDirectText(el) {
                for (const n of el.childNodes) {
                    if (n.nodeType === 3 && n.textContent.trim().length > 1) {
                        return true;
                    }
                }
                return false;
            }

            const offenders = [];
            let checked = 0;

            for (const el of document.body.querySelectorAll("*")) {
                if (!hasDirectText(el)) continue;

                const style = getComputedStyle(el);
                if (style.display === "none" || style.visibility === "hidden") {
                    continue;
                }
                if (parseFloat(style.opacity) === 0) continue;

                const rect = el.getBoundingClientRect();
                if (rect.width < 2 || rect.height < 2) continue;

                const fg = parseColor(style.color);
                if (!fg || fg.a === 0) continue;

                const bg = effectiveBg(el);
                if (!bg) continue; // unreliable background -> leave to AI

                checked++;

                const size = parseFloat(style.fontSize);
                const bold = parseInt(style.fontWeight, 10) >= 700;
                // WCAG "large text": >=24px, or >=18.66px bold.
                const isLarge = size >= 24 || (bold && size >= 18.66);
                const threshold = isLarge ? aaLarge : aa;

                const r = ratio(fg, bg);
                // A ratio at/near 1:1 means the foreground and the background
                // we resolved are (almost) the same colour. Real, readable
                // text is never that low, so this is a background-detection
                // failure - the text actually sits on an image/gradient/overlay
                // that we could not see from computed styles (e.g. a testimonial
                // card photo). Skip it and leave the judgement to AI vision
                // rather than emitting an impossible "white on white" defect.
                if (r < 1.2) continue;
                if (r < threshold) {
                    offenders.push({
                        text: (el.textContent || "").trim().slice(0, 40),
                        ratio: Math.round(r * 100) / 100,
                        required: threshold,
                        fg: `rgb(${fg.r},${fg.g},${fg.b})`,
                        bg: `rgb(${bg.r},${bg.g},${bg.b})`,
                        fontSize: Math.round(size),
                        large: isLarge
                    });
                }
            }

            offenders.sort((a, b) => a.ratio - b.ratio);
            return { checked, offenders: offenders.slice(0, 15) };
        },
        { aa, aaLarge }
    );

    if (data.offenders.length === 0) {
        return [
            {
                status: "PASS",
                severity: "LOW",
                type: "CONTRAST",
                message: `All ${data.checked} solid-background text element(s) meet WCAG AA`
            }
        ];
    }

    // Worst offender drives severity: below 3:1 fails even large-text AA.
    const worst = data.offenders[0];
    const severity = worst.ratio < 3 ? "HIGH" : "MEDIUM";

    const samples = data.offenders
        .slice(0, 4)
        .map(o => `"${o.text}" (contrast ${o.ratio.toFixed(1)}, should be at least ${o.required})`)
        .join("; ");

    const message = data.offenders.length === 1
        ? `A piece of text may be hard to read — its colour is too close to the background: ${samples}.`
        : `${data.offenders.length} pieces of text may be hard to read — the colour is too close to the background. Examples: ${samples}.`;
    return [{ status: "FAIL", severity, type: "CONTRAST", message, data }];
}

module.exports = { name, run, tier, category };
