const fs = require("fs");
const path = require("path");

const SCANS_ROOT = path.join(__dirname, "..", "scans");

/**
 * Turn an arbitrary string into a filesystem-safe folder segment.
 */
function safeSegment(value) {
    return String(value)
        .trim()
        .replace(/[^a-zA-Z0-9._-]+/g, "_")
        .replace(/^_+|_+$/g, "") || "unnamed";
}

// Short, human-friendly browser codes used in screenshot file names.
const BROWSER_CODES = {
    chromium: "chrome",
    firefox: "firefox",
    webkit: "webkit"
};

/**
 * Lowercase, hyphenated slug for use inside a screenshot file name.
 * e.g. "QR Preview" -> "qr-preview", "pt-br" -> "pt-br".
 */
function slugify(value) {
    return (
        String(value)
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "") || "page"
    );
}

function browserCode(browser) {
    const key = String(browser).toLowerCase();
    return BROWSER_CODES[key] || slugify(browser);
}

/**
 * Build the descriptive screenshot base name for a combination:
 *   <page>-<WxH>-<browser>-<lang>
 * e.g. "home-1024x768-chrome-en". segmentedCapture appends the per-screen
 * suffix ("-01", "-02", ...) so tall pages split into multiple, ordered files.
 */
function screenshotBaseName(combination) {
    const { page, browser, language, viewport } = combination;
    return [
        slugify(page),
        `${viewport.width}x${viewport.height}`,
        browserCode(browser),
        slugify(language)
    ].join("-");
}

/**
 * Create a unique scan folder rooted at scans/<timestamp>.
 * Returns both the absolute path and the scan id (timestamp) so callers
 * can build report URLs and relative screenshot paths.
 */
function createScanFolder() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const folder = path.join(SCANS_ROOT, timestamp);
    fs.mkdirSync(folder, { recursive: true });
    return { id: timestamp, folder };
}

/**
 * Create the folder for a single combination:
 *   scans/<timestamp>/<page>/
 *
 * Screenshots are grouped per page and the full combination (size, browser,
 * language, screen index) is encoded in the file NAME itself
 * (see screenshotBaseName), so files never collide and are self-describing.
 */
function createCombinationFolder(scanFolder, combination) {
    const folder = path.join(scanFolder, slugify(combination.page));
    fs.mkdirSync(folder, { recursive: true });
    return folder;
}

/**
 * Return an absolute path expressed relative to the scans root, using
 * forward slashes. Used so reports can reference screenshots portably.
 */
function toScanRelative(absolutePath) {
    return path
        .relative(SCANS_ROOT, absolutePath)
        .split(path.sep)
        .join("/");
}

module.exports = {
    SCANS_ROOT,
    safeSegment,
    slugify,
    browserCode,
    screenshotBaseName,
    createScanFolder,
    createCombinationFolder,
    toScanRelative
};
