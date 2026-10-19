/**
 * Log in through the site's own login form and return a Playwright
 * storageState (cookies/localStorage) that the scanner reuses for authenticated
 * pages (dashboards, funnels, create/generate). Credentials come from .env ONLY
 * — never hardcoded. Each scan context is otherwise fresh, so there are no
 * stale-cache problems.
 *
 * Credentials (per brand first, then global):
 *   QA_EMAIL_<BRAND> / QA_PASSWORD_<BRAND>   e.g. QA_EMAIL_OQG
 *   QA_EMAIL / QA_PASSWORD                    fallback for all brands
 */
const { launchBrowser, createContext } = require("../playwright/browser");

function brandOf(website) {
    try { return (new URL(website).hostname.split(".")[0] || "").toUpperCase(); }
    catch (e) { return ""; }
}

function credsFor(website) {
    const b = brandOf(website);
    return {
        email: process.env[`QA_EMAIL_${b}`] || process.env.QA_EMAIL || "",
        password: process.env[`QA_PASSWORD_${b}`] || process.env.QA_PASSWORD || ""
    };
}

/**
 * @returns {Promise<{storageState:object|null, ok:boolean, reason?:string, finalUrl?:string}>}
 *   ok=false with reason="no-credentials" means scan proceeds unauthenticated.
 */
async function login(website, config = {}) {
    const auth = config.auth || {};
    if (auth.enabled === false) return { storageState: null, ok: false, reason: "disabled" };

    const { email, password } = credsFor(website);
    if (!email || !password) return { storageState: null, ok: false, reason: "no-credentials" };

    const lang = (config.languages && config.languages[0]) || "en";
    const loginPath = auth.loginPath || "/login";
    const path = config.localeInPath ? `/${lang}${loginPath}` : loginPath;
    const loginUrl = new URL(path, website).toString();

    const emailSel = auth.emailSelector ||
        "input[type=email], input[name=email], input[name=username], input#email, input#username";
    const passSel = auth.passwordSelector ||
        "input[type=password], input[name=password], input#password";
    const submitSel = auth.submitSelector ||
        "button[type=submit], input[type=submit]";

    const browser = await launchBrowser((config.browsers && config.browsers[0]) || "chromium");
    try {
        const context = await createContext(browser, { width: 1366, height: 900 }, lang);
        const page = await context.newPage();
        await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForLoadState("load", { timeout: 10000 }).catch(() => {});

        await page.locator(emailSel).first().fill(email, { timeout: 15000 });
        await page.locator(passSel).first().fill(password, { timeout: 15000 });

        // Click submit; fall back to pressing Enter if no obvious submit button.
        const submit = page.locator(submitSel).first();
        if (await submit.count().catch(() => 0)) {
            await submit.click({ timeout: 10000 }).catch(() => page.keyboard.press("Enter"));
        } else {
            await page.keyboard.press("Enter");
        }
        await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(1500);

        // Heuristic success: we are no longer on the login page.
        const ok = !/\/login(\b|\/|$)/i.test(page.url());
        const storageState = await context.storageState();
        const finalUrl = page.url();
        await context.close();
        return { storageState: ok ? storageState : null, ok, reason: ok ? undefined : "login-did-not-complete", finalUrl };
    } catch (err) {
        return { storageState: null, ok: false, reason: err.message };
    } finally {
        await browser.close();
    }
}

module.exports = { login, credsFor };
