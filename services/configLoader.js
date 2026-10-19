const fs = require("fs");
const path = require("path");

const DEFAULT_CONFIG_PATH = path.join(
    __dirname,
    "..",
    "config",
    "project.json"
);

/**
 * Load and normalize a scan configuration.
 *
 * @param {object} [override] Optional config object (e.g. from an API body).
 *   When provided it is validated/normalized directly instead of reading
 *   project.json from disk.
 * @returns {object} A fully normalized config with defaults applied.
 */
function loadConfig(override) {
    const raw = override
        ? override
        : JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, "utf8"));

    return normalizeConfig(raw);
}

function normalizeConfig(raw) {
    if (!raw || typeof raw !== "object") {
        throw new Error("Config must be a JSON object");
    }

    if (!raw.website || typeof raw.website !== "string") {
        throw new Error("Config.website is required and must be a string");
    }

    // Validate the website is a parseable URL early, so we fail fast.
    try {
        // eslint-disable-next-line no-new
        new URL(raw.website);
    } catch (err) {
        throw new Error(`Config.website is not a valid URL: ${raw.website}`);
    }

    // Multi-brand / multi-environment targets. The UI builds a base URL from
    // urlTemplate (e.g. "https://{brand}.{env}.test-qr.com"); `overrides` maps a
    // "brand.env" key to a full base URL for anything that breaks the pattern.
    const sitesRaw = raw.sites && typeof raw.sites === "object" ? raw.sites : {};
    const sites = {
        urlTemplate: typeof sitesRaw.urlTemplate === "string" ? sitesRaw.urlTemplate : "",
        brands: Array.isArray(sitesRaw.brands) ? sitesRaw.brands.map(String) : [],
        environments: Array.isArray(sitesRaw.environments) ? sitesRaw.environments.map(String) : [],
        overrides:
            sitesRaw.overrides && typeof sitesRaw.overrides === "object"
                ? sitesRaw.overrides
                : {}
    };

    // Login config for authenticated pages (credentials come from .env).
    const authRaw = raw.auth && typeof raw.auth === "object" ? raw.auth : {};
    const auth = {
        enabled: authRaw.enabled !== false,
        loginPath: typeof authRaw.loginPath === "string" ? authRaw.loginPath : "/login",
        emailSelector: authRaw.emailSelector || "",
        passwordSelector: authRaw.passwordSelector || "",
        submitSelector: authRaw.submitSelector || ""
    };

    const pages = Array.isArray(raw.pages) && raw.pages.length
        ? raw.pages
        : [{ name: "Home", path: "/" }];

    const normalizedPages = pages.map((page, i) => {
        if (!page || typeof page !== "object") {
            throw new Error(`Config.pages[${i}] must be an object`);
        }
        const p = page.path || "/";
        const name = page.name || `Page${i + 1}`;
        return { name, path: p };
    });

    const browsers = normalizeStringList(
        raw.browsers,
        ["chromium"],
        ["chromium", "firefox", "webkit"],
        "browsers"
    );

    const languages = normalizeStringList(
        raw.languages,
        ["en"],
        null,
        "languages"
    );

    const viewports = Array.isArray(raw.viewports) && raw.viewports.length
        ? raw.viewports
        : [{ name: "Desktop", width: 1366, height: 768 }];

    const normalizedViewports = viewports.map((vp, i) => {
        if (!vp || typeof vp !== "object") {
            throw new Error(`Config.viewports[${i}] must be an object`);
        }
        const width = Number(vp.width);
        const height = Number(vp.height);
        if (!Number.isFinite(width) || !Number.isFinite(height)) {
            throw new Error(
                `Config.viewports[${i}] requires numeric width and height`
            );
        }
        const name = vp.name || `${width}x${height}`;
        return { name, width, height };
    });

    const ai = raw.ai && typeof raw.ai === "object" ? raw.ai : {};
    const provider = ai.provider || (ai.enabled ? "openai" : "mock");
    if (!["mock", "openai", "ollama"].includes(provider)) {
        throw new Error(
            `Config.ai.provider "${provider}" is unsupported. ` +
            "Allowed: mock, openai, ollama"
        );
    }

    const baseURL = ai.baseURL || "http://127.0.0.1:11434";
    if (provider === "ollama") {
        try {
            // eslint-disable-next-line no-new
            new URL(baseURL);
        } catch (err) {
            throw new Error(`Config.ai.baseURL is not a valid URL: ${baseURL}`);
        }
    }

    const timeoutMs = Number(ai.timeoutMs) || 120000;
    if (timeoutMs < 1000) {
        throw new Error("Config.ai.timeoutMs must be at least 1000");
    }

    // Keep the local model in its fast, low-memory 4096 context. We fit inside it
    // by shrinking the screenshot to `ollamaMaxPixels` before sending (see
    // ai/analyzer.ollamaImageBase64). Raising numCtx instead allocates a bigger
    // KV cache up front and can push a modest machine into swap (very slow).
    const numCtx = Number(ai.numCtx) || 4096;
    const ollamaMaxPixels = Number(ai.ollamaMaxPixels) || 1000000;
    // Cloud providers (Claude/Gemini/GPT) get a larger budget than the local
    // model, but still downscaled to keep per-image token cost down.
    const maxPixels = Number(ai.maxPixels) || 1500000;

    const normalizedAi = {
        enabled: Boolean(ai.enabled),
        provider,
        model:
            ai.model ||
            (provider === "ollama" ? "qwen2.5vl:7b" : "gpt-4o-mini"),
        baseURL,
        timeoutMs,
        numCtx,
        ollamaMaxPixels,
        maxPixels
    };

    const thresholds =
        raw.thresholds && typeof raw.thresholds === "object"
            ? raw.thresholds
            : {};
    const normalizedThresholds = {
        contrastAA: Number(thresholds.contrastAA) || 4.5,
        contrastAALarge: Number(thresholds.contrastAALarge) || 3.0
    };

    return {
        website: raw.website,
        sites,
        auth,
        pages: normalizedPages,
        browsers,
        languages,
        viewports: normalizedViewports,
        localeInPath: Boolean(raw.localeInPath),
        ai: normalizedAi,
        thresholds: normalizedThresholds
    };
}

function normalizeStringList(value, fallback, allowed, label) {
    let list = Array.isArray(value) && value.length ? value : fallback;

    list = list.map(item => {
        if (typeof item !== "string" || !item.trim()) {
            throw new Error(`Config.${label} entries must be non-empty strings`);
        }
        return item.trim();
    });

    if (allowed) {
        for (const item of list) {
            if (!allowed.includes(item)) {
                throw new Error(
                    `Config.${label} contains unsupported value "${item}". ` +
                    `Allowed: ${allowed.join(", ")}`
                );
            }
        }
    }

    return list;
}

module.exports = {
    loadConfig,
    normalizeConfig
};
