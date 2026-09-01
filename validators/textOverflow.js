/**
 * Text Overflow validator.
 *
 * Detects text that is clipped or spilling out of its container:
 *  - clipped: overflow:hidden and scrollWidth/scrollHeight exceeds the box
 *  - ellipsis: text-overflow:ellipsis actively truncating content
 *  - spilling: content wider than its container (potential layout break)
 */
const name = "textOverflow";

async function run(page) {
    const data = await page.evaluate(() => {
        const clipped = [];
        const ellipsis = [];
        const spilling = [];

        const describe = el =>
            `<${el.tagName.toLowerCase()}${el.id ? ` id="${el.id}"` : ""}>` +
            ` "${(el.textContent || "").trim().slice(0, 30)}"`;

        const nodes = document.body
            ? document.body.querySelectorAll("*")
            : [];

        for (const el of nodes) {
            const text = (el.textContent || "").trim();
            if (!text) continue;
            // Only leaf-ish text nodes to avoid double counting containers.
            if (el.children.length > 3) continue;

            const style = getComputedStyle(el);
            const overflowX = style.overflowX;
            const overflowY = style.overflowY;

            const clipX = overflowX === "hidden" || overflowX === "clip";
            const clipY = overflowY === "hidden" || overflowY === "clip";

            if (
                clipX &&
                el.scrollWidth > el.clientWidth + 1 &&
                el.clientWidth > 0
            ) {
                if (style.textOverflow === "ellipsis") {
                    if (ellipsis.length < 8) ellipsis.push(describe(el));
                } else if (clipped.length < 8) {
                    clipped.push(describe(el));
                }
            } else if (
                clipY &&
                el.scrollHeight > el.clientHeight + 1 &&
                el.clientHeight > 0 &&
                clipped.length < 8
            ) {
                clipped.push(describe(el));
            } else if (
                !clipX &&
                el.scrollWidth > el.clientWidth + 2 &&
                el.clientWidth > 0 &&
                spilling.length < 8
            ) {
                spilling.push(describe(el));
            }
        }

        return { clipped, ellipsis, spilling };
    });

    const findings = [];

    if (data.clipped.length) {
        findings.push({
            status: "FAIL",
            severity: "HIGH",
            type: "TEXT_OVERFLOW",
            message:
                `${data.clipped.length} element(s) have clipped/cut-off text: ` +
                data.clipped.slice(0, 4).join("; "),
            data: { clipped: data.clipped }
        });
    }

    if (data.ellipsis.length) {
        findings.push({
            status: "WARN",
            severity: "MEDIUM",
            type: "TEXT_OVERFLOW",
            message:
                `${data.ellipsis.length} element(s) truncated with an ` +
                `ellipsis: ${data.ellipsis.slice(0, 4).join("; ")}`,
            data: { ellipsis: data.ellipsis }
        });
    }

    if (data.spilling.length) {
        findings.push({
            status: "WARN",
            severity: "MEDIUM",
            type: "TEXT_OVERFLOW",
            message:
                `${data.spilling.length} element(s) have content wider than ` +
                `their container: ${data.spilling.slice(0, 4).join("; ")}`,
            data: { spilling: data.spilling }
        });
    }

    if (findings.length === 0) {
        findings.push({
            status: "PASS",
            severity: "LOW",
            type: "TEXT_OVERFLOW",
            message: "No text overflow issues detected"
        });
    }

    return findings;
}

// Width comparisons flag intentional ellipsis/clamping as "cut off". The
// screenshot is the source of truth for text clipping, so this is a HINT.
const tier = "hint";
const category = "Text";

module.exports = { name, run, tier, category };
