require("dotenv").config();

const path = require("path");
const express = require("express");

const { loadConfig } = require("./services/configLoader");
const { runScan } = require("./services/scanner");
const { generateCombinations } = require("./services/combinationGenerator");
const jobStore = require("./services/jobStore");
const analyzer = require("./ai/analyzer");
const { analyzeImages, UPLOADS_ROOT } = require("./services/imageAnalyze");
const { SCANS_ROOT } = require("./utils/folder");

const app = express();

// Config bodies are tiny; uploaded screenshots (base64) are not. Use a small
// default parser everywhere but a larger one only on the upload endpoint.
const smallJson = express.json({ limit: "1mb" });
const bigJson = express.json({ limit: "30mb" });
app.use((req, res, next) => {
    (req.path === "/analyze" ? bigJson : smallJson)(req, res, next);
});

// Serve raw scan artifacts (screenshots, report.json/html) for browsing.
app.use("/scans", express.static(SCANS_ROOT));
// Serve uploaded screenshots back to the UI.
app.use("/uploads", express.static(UPLOADS_ROOT));
// The screenshot-analysis web UI.
app.use(express.static(path.join(__dirname, "public")));

app.get("/api", (req, res) => {
    res.json({
        status: "running",
        service: "AI Responsive QA Agent",
        endpoints: {
            "GET /providers": "List vision providers and their availability.",
            "POST /analyze": "Analyze uploaded screenshot(s). Returns verdicts.",
            "POST /scan": "Start a scan (optional config body). Returns scanId.",
            "GET /scan/:id": "Poll scan progress.",
            "GET /report/:id": "HTML report (?format=json for JSON)."
        }
    });
});

/**
 * GET /providers - which vision models can be used right now (and which are
 * free), so the UI can offer a model picker and flag ones missing an API key.
 */
app.get("/providers", (req, res) => {
    res.json({ providers: analyzer.listProviders() });
});

/**
 * GET /config - the current project config, so the UI can build the capture
 * form (which pages / browsers / languages / viewports are available).
 */
app.get("/config", (req, res) => {
    try {
        const c = loadConfig();
        res.json({
            website: c.website,
            localeInPath: c.localeInPath,
            pages: c.pages,
            browsers: c.browsers,
            languages: c.languages,
            viewports: c.viewports
        });
    } catch (err) {
        res.status(400).json({ status: "error", message: err.message });
    }
});

/**
 * POST /analyze
 * Body: { images: [{ dataUrl, filename?, meta? }] }
 * Runs each uploaded screenshot through the AI vision reviewer and returns a
 * verdict per image. Synchronous — screenshots are analyzed before responding.
 */
app.post("/analyze", async (req, res) => {
    const images = req.body && Array.isArray(req.body.images)
        ? req.body.images
        : [];
    if (images.length === 0) {
        return res.status(400).json({
            status: "error",
            message: "Body must include a non-empty `images` array."
        });
    }

    let config;
    try {
        config = loadConfig();
    } catch (err) {
        return res.status(400).json({ status: "error", message: err.message });
    }

    const providers = Array.isArray(req.body.providers)
        ? req.body.providers.filter(p => analyzer.PROVIDERS[p])
        : null;

    try {
        const results = await analyzeImages(images, config, providers);
        return res.json({
            status: "done",
            provider: analyzer.getProvider(config),
            aiActive: analyzer.aiIsActive(config),
            providers: providers || null,
            count: results.length,
            results
        });
    } catch (err) {
        return res.status(500).json({ status: "error", message: err.message });
    }
});

/**
 * POST /scan
 * Body: optional config object. Falls back to config/project.json.
 * Returns immediately with { scanId, status } and runs the scan in the
 * background so n8n / clients can poll GET /scan/:id.
 */
app.post("/scan", (req, res) => {
    let config;
    try {
        const hasBody = req.body && Object.keys(req.body).length > 0;
        config = loadConfig(hasBody ? req.body : undefined);
    } catch (err) {
        return res.status(400).json({ status: "error", message: err.message });
    }

    const total = generateCombinations(config).length;
    const job = jobStore.createJob({ total, config });

    // Fire-and-forget. Errors are captured onto the job.
    runScan(config, { jobId: job.scanId }).catch(err => {
        // eslint-disable-next-line no-console
        console.error(`Scan ${job.scanId} failed:`, err);
        jobStore.updateJob(job.scanId, {
            status: "error",
            error: err.message,
            finishedAt: new Date().toISOString()
        });
    });

    res.status(202).json({
        status: "started",
        scanId: job.scanId,
        total,
        progressUrl: `/scan/${job.scanId}`,
        reportUrl: `/report/${job.scanId}`
    });
});

/**
 * GET /scan/:id - progress polling.
 */
app.get("/scan/:id", (req, res) => {
    const progress = jobStore.getProgress(req.params.id);
    if (!progress) {
        return res.status(404).json({ status: "error", message: "Unknown scanId" });
    }
    res.json(progress);
});

/**
 * GET /report/:id - HTML report by default, JSON with ?format=json.
 */
app.get("/report/:id", (req, res) => {
    const job = jobStore.getJob(req.params.id);
    if (!job) {
        return res.status(404).json({ status: "error", message: "Unknown scanId" });
    }
    if (job.status !== "done") {
        return res.status(409).json({
            status: "pending",
            message: `Scan is "${job.status}". Poll /scan/${job.scanId}.`,
            progress: jobStore.getProgress(job.scanId)
        });
    }

    if (req.query.format === "json") {
        return res.json(job.report);
    }

    return res.sendFile(job.reportHtmlPath);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`AI Responsive QA Agent running on http://localhost:${PORT}`);
});

module.exports = app;
