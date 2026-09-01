/**
 * Expand a normalized config into the full cartesian product of
 * page x browser x language x viewport combinations.
 *
 * Keeping this as a pure function makes the scanner trivial to test and
 * lets us compute the total combination count up-front for progress
 * reporting (GET /scan/:id).
 *
 * @param {object} config Normalized config (see services/configLoader.js).
 * @returns {Array<object>} One entry per combination.
 */
function generateCombinations(config) {
    const { website, pages, browsers, languages, viewports, localeInPath } =
        config;

    const combinations = [];

    for (const page of pages) {
        for (const browser of browsers) {
            for (const language of languages) {
                // For path-localized sites the locale is a URL prefix
                // (/en/create), not just an Accept-Language header. When
                // localeInPath is set we build a per-language URL so every
                // locale actually hits its localized route.
                const effectivePath = localeInPath
                    ? localizePath(page.path, language)
                    : page.path;
                const url = new URL(effectivePath, website).toString();

                for (const viewport of viewports) {
                    combinations.push({
                        page: page.name,
                        path: effectivePath,
                        url,
                        browser,
                        language,
                        viewport
                    });
                }
            }
        }
    }

    return combinations;
}

/**
 * Prepend a locale segment to a route path: "/" -> "/en", "/create" ->
 * "/en/create". Existing leading/trailing slashes are handled so the result
 * is always a clean absolute path.
 */
function localizePath(pagePath, locale) {
    const clean = String(pagePath || "/").replace(/^\/+/, "");
    return clean ? `/${locale}/${clean}` : `/${locale}`;
}

module.exports = {
    generateCombinations
};
