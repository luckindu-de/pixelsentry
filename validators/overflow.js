/**
 * Horizontal Overflow validator.
 *
 * Detects when the document is wider than the viewport, which forces
 * horizontal scrolling - one of the most common responsive defects.
 */
const name = "overflow";

async function run(page) {
    const data = await page.evaluate(() => {
        const doc = document.documentElement;
        const scrollWidth = doc.scrollWidth;
        const clientWidth = doc.clientWidth;

        // Identify the widest offending elements to make the message useful.
        const offenders = [];
        const all = document.body ? document.body.querySelectorAll("*") : [];
        for (const el of all) {
            const rect = el.getBoundingClientRect();
            if (rect.right > clientWidth + 1 && rect.width > 0) {
                offenders.push({
                    tag: el.tagName.toLowerCase(),
                    id: el.id || null,
                    className:
                        typeof el.className === "string" ? el.className : null,
                    right: Math.round(rect.right)
                });
            }
        }
        offenders.sort((a, b) => b.right - a.right);

        return {
            scrollWidth,
            clientWidth,
            overflow: scrollWidth - clientWidth,
            offenders: offenders.slice(0, 5)
        };
    });

    if (data.scrollWidth <= data.clientWidth + 1) {
        return [
            {
                status: "PASS",
                severity: "LOW",
                type: "OVERFLOW",
                message: "No horizontal overflow detected"
            }
        ];
    }

    const noun = t =>
        ({ img: "an image", svg: "a graphic", table: "a table", video: "a video", pre: "a code block" }[t] ||
            "a section");
    const first = data.offenders[0];
    const detail = first ? ` The widest thing is ${noun(first.tag)} sticking out past the edge.` : "";

    return [
        {
            status: "FAIL",
            severity: "HIGH",
            type: "OVERFLOW",
            message:
                `The page is wider than the screen, so it scrolls sideways — content runs ` +
                `${data.overflow}px past the ${data.clientWidth}px screen width.${detail}`,
            data
        }
    ];
}

// Horizontal overflow is objectively measurable and user-visible (the page
// can actually be scrolled sideways), so it is treated as authoritative.
const tier = "authoritative";
const category = "Layout";

module.exports = { name, run, tier, category };
