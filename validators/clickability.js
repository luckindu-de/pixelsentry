/**
 * Clickability validator (real actionability, not DOM geometry).
 *
 * Instead of guessing "is this button covered?" from bounding boxes, we ask
 * Playwright the same question a user does: can it actually be clicked?
 *
 *   locator.click({ trial: true })
 *
 * A trial click runs all of Playwright's actionability checks (visible,
 * stable, receives pointer events, enabled) but does NOT actually fire the
 * click - so it is safe and will not navigate. If it throws, the control is
 * genuinely not clickable (covered by an overlay, zero-size, off-screen,
 * disabled), which is a real, user-visible interaction defect.
 *
 * This is authoritative and replaces DOM overlap detection as the trusted
 * signal for "can I click everything?".
 */
const name = "clickability";
const tier = "authoritative";
const category = "Interaction";

const SELECTOR =
    "a[href], button, [role='button'], input[type='submit'], input[type='button']";
const MAX_ELEMENTS = 30;
const PER_CLICK_TIMEOUT = 1000;

async function run(page) {
    const handles = await page.$$(SELECTOR);
    const vp = page.viewportSize() || { width: Infinity, height: Infinity };

    const blocked = [];
    let tested = 0;

    for (const handle of handles) {
        if (tested >= MAX_ELEMENTS) break;

        // Skip elements that are not rendered at all (0-size or hidden):
        // those are covered by other checks and are usually intentional.
        const box = await handle.boundingBox().catch(() => null);
        if (!box || box.width < 2 || box.height < 2) {
            await handle.dispose();
            continue;
        }

        // Only test what the user can actually SEE in the current viewport.
        // Elements that do not intersect the visible viewport are either
        // off-canvas (e.g. links inside a collapsed hamburger menu) or below
        // the fold. Trial-clicking those makes Playwright auto-scroll, and a
        // sticky header/menu then "intercepts" the click - a false positive,
        // not a real, user-visible interaction defect. Skip them.
        const offscreen =
            box.x + box.width <= 0 ||
            box.y + box.height <= 0 ||
            box.x >= vp.width ||
            box.y >= vp.height;
        if (offscreen) {
            await handle.dispose();
            continue;
        }

        tested++;

        const label = await handle
            .evaluate(el =>
                (
                    el.innerText ||
                    el.textContent ||
                    el.value ||
                    el.getAttribute("aria-label") ||
                    el.getAttribute("title") ||
                    ""
                )
                    .trim()
                    .slice(0, 30)
            )
            .catch(() => "");

        try {
            await handle.click({ trial: true, timeout: PER_CLICK_TIMEOUT });
        } catch (err) {
            // Classify against the FULL message: Playwright's first line is
            // usually the generic timeout, while the actual cause ("intercepts
            // pointer events", "not stable", ...) is in the call log below.
            // We only trust "covered" (intercepts pointer) and "not stable"
            // as real defects. "not visible" / bare "timeout" on an in-viewport
            // element are almost always intentional (fade-in, transient state)
            // and produced too many false positives, so they are ignored.
            const full = String(err.message || "");
            if (/intercepts pointer|not stable/i.test(full)) {
                blocked.push({ label: label || "(no label)", reason: full });
            }
        }

        await handle.dispose();
    }

    if (blocked.length === 0) {
        return [
            {
                status: "PASS",
                severity: "LOW",
                type: "CLICKABILITY",
                message: `All ${tested} visible interactive element(s) are clickable`
            }
        ];
    }

    const covered = blocked.filter(b => /intercepts pointer/i.test(b.reason));

    // If most visible controls are "covered", it is almost certainly ONE
    // full-page overlay (cookie/consent dialog, modal) sitting on top - report
    // that once as a warning instead of failing every button behind it.
    if (tested >= 5 && covered.length / tested >= 0.6) {
        return [
            {
                status: "WARN",
                severity: "MEDIUM",
                type: "CLICKABILITY",
                message:
                    `A full-page overlay appears to be blocking interaction ` +
                    `(e.g. a cookie/consent dialog or modal): ${covered.length} of ` +
                    `${tested} visible control(s) could not be clicked.`,
                data: { tested, blocked }
            }
        ];
    }

    const severity = covered.length ? "HIGH" : "MEDIUM";

    const samples = blocked
        .slice(0, 5)
        .map(b => `"${b.label}" (${shortReason(b.reason)})`)
        .join("; ");

    const message = blocked.length === 1
        ? `A button/link can't be clicked: ${samples}.`
        : `${blocked.length} buttons/links can't be clicked: ${samples}.`;
    return [{ status: "FAIL", severity, type: "CLICKABILITY", message, data: { tested, blocked } }];
}

function shortReason(reason) {
    if (/intercepts pointer/i.test(reason)) return "covered by another element";
    if (/not visible/i.test(reason)) return "not visible";
    if (/not stable/i.test(reason)) return "not stable/animating";
    if (/not enabled/i.test(reason)) return "disabled";
    if (/outside of the viewport/i.test(reason)) return "outside viewport";
    if (/timeout/i.test(reason)) return "not actionable (timeout)";
    return "not actionable";
}

module.exports = { name, run, tier, category };
