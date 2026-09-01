const crypto = require("crypto");

/**
 * In-memory job store for async scans.
 *
 * Keeps scan progress and the finished report keyed by scanId. This is a
 * deliberately simple MVP store; swapping in Redis/a DB later only requires
 * reimplementing these functions (the rest of the app depends only on this
 * interface).
 */

const jobs = new Map();

function createJob({ total = 0, config } = {}) {
    const id = crypto.randomUUID();
    const job = {
        scanId: id,
        status: "queued", // queued -> running -> done | error
        total,
        completed: 0,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        config,
        summary: null,
        report: null, // full JSON report once done
        reportHtmlPath: null,
        scanFolder: null,
        error: null
    };
    jobs.set(id, job);
    return job;
}

function getJob(id) {
    return jobs.get(id) || null;
}

function updateJob(id, patch) {
    const job = jobs.get(id);
    if (!job) return null;
    Object.assign(job, patch);
    return job;
}

/**
 * Public-facing progress view (omits the heavy report payload).
 */
function getProgress(id) {
    const job = jobs.get(id);
    if (!job) return null;
    return {
        scanId: job.scanId,
        status: job.status,
        total: job.total,
        completed: job.completed,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        summary: job.summary,
        error: job.error
    };
}

module.exports = {
    createJob,
    getJob,
    updateJob,
    getProgress
};
