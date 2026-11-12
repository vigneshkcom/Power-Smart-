// Best-effort archival of the same PDF buffers sent in customer emails.
// Never changes whether an email is considered sent.
async function saveCustomerDocuments(job, attachments) {
  try {
    const Dropbox = require("./_dropbox");
    if (!Dropbox.configured()) throw new Error("Dropbox credentials are missing");
    const result = await Dropbox.uploadDocuments(job, attachments);
    if (result.failed.length) {
      const details = result.failed.map((f) => f.filename + ": " + f.error).join("; ");
      console.error("Dropbox archive incomplete for J" + job.job_no + ":", details);
      await noteFailure(job, details);
      return { status: "partial", ...result };
    }
    return { status: "saved", ...result };
  } catch (error) {
    console.error("Dropbox archive failed for J" + job.job_no + ":", error.message);
    await noteFailure(job, error.message);
    return { status: "failed", error: error.message };
  }
}

async function noteFailure(job, details) {
  if (!job.lead_id) return;
  try {
    await require("./_jobs").leadNote(job.lead_id, "System",
      "⚠️ Dropbox Documents backup for J" + job.job_no + " failed: " + String(details).slice(0, 400) + ". Customer email was not affected.");
  } catch (_) { /* The backup warning must not affect customer communications. */ }
}

module.exports = { saveCustomerDocuments };
