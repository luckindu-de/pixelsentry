/**
 * Broken Images validator.
 *
 * Detects:
 *  - <img> with empty/missing src
 *  - <img> that failed to render (naturalWidth === 0 after load)
 *  - image network requests that failed (passed in from capture.js via the
 *    requestfailed listener, which is more reliable than DOM inspection for
 *    lazy-loaded or background images)
 */
const name = "brokenImages";

async function run(page, context = {}) {
    const imageRequestFailures = context.imageRequestFailures || [];

    const data = await page.evaluate(() => {
        const result = { emptySrc: [], notRendered: [], total: 0 };
        const imgs = document.querySelectorAll("img");
        result.total = imgs.length;

        for (const img of imgs) {
            const src = img.getAttribute("src");
            if (!src || src.trim() === "") {
                result.emptySrc.push(
                    img.alt ? `alt="${img.alt}"` : "(no alt)"
                );
                continue;
            }
            // complete === true and naturalWidth === 0 => failed to load.
            if (img.complete && img.naturalWidth === 0) {
                result.notRendered.push(src.slice(0, 80));
            }
        }
        return result;
    });

    const findings = [];

    if (data.emptySrc.length) {
        findings.push({
            status: "FAIL",
            severity: "MEDIUM",
            type: "BROKEN_IMAGE",
            message:
                `${data.emptySrc.length} image(s) have an empty/missing src: ` +
                data.emptySrc.slice(0, 5).join(", "),
            data: { emptySrc: data.emptySrc }
        });
    }

    if (data.notRendered.length) {
        findings.push({
            status: "FAIL",
            severity: "HIGH",
            type: "BROKEN_IMAGE",
            message:
                `${data.notRendered.length} image(s) failed to render: ` +
                data.notRendered.slice(0, 5).join(", "),
            data: { notRendered: data.notRendered }
        });
    }

    if (imageRequestFailures.length) {
        findings.push({
            status: "FAIL",
            severity: "HIGH",
            type: "BROKEN_IMAGE",
            message:
                `${imageRequestFailures.length} image request(s) failed: ` +
                imageRequestFailures.slice(0, 5).join(", "),
            data: { imageRequestFailures }
        });
    }

    if (findings.length === 0) {
        findings.push({
            status: "PASS",
            severity: "LOW",
            type: "BROKEN_IMAGE",
            message: `All ${data.total} image(s) loaded successfully`
        });
    }

    return findings;
}

// Failed image loads / empty src / naturalWidth===0 are objective facts.
const tier = "authoritative";
const category = "Image";

module.exports = { name, run, tier, category };
