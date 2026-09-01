const playwright = require("playwright");

const SUPPORTED = ["chromium", "firefox", "webkit"];

/**
 * Launch a Playwright browser by engine name.
 *
 * @param {string} name "chromium" | "firefox" | "webkit"
 * @returns {Promise<import('playwright').Browser>}
 */
async function launchBrowser(name) {
    if (!SUPPORTED.includes(name)) {
        throw new Error(
            `Unsupported browser "${name}". Supported: ${SUPPORTED.join(", ")}`
        );
    }

    return playwright[name].launch();
}

/**
 * Create a browser context configured for a viewport and language.
 *
 * Language is applied both as the context `locale` (affects
 * Intl / navigator.language) and as an explicit Accept-Language header so
 * servers that negotiate content by header respond in the right language.
 *
 * @param {import('playwright').Browser} browser
 * @param {{width:number,height:number}} viewport
 * @param {string} language BCP-47 language tag, e.g. "en", "ja", "fr".
 * @returns {Promise<import('playwright').BrowserContext>}
 */
async function createContext(browser, viewport, language) {
    return browser.newContext({
        viewport: {
            width: viewport.width,
            height: viewport.height
        },
        locale: language,
        extraHTTPHeaders: {
            "Accept-Language": language
        }
    });
}

module.exports = {
    SUPPORTED,
    launchBrowser,
    createContext
};
