// Creates a formatted Excel workbook from the currently filtered pipeline leads.

const ExcelJS = require("exceljs");

const PORTAL_KEY = "2026";
const MAX_ROWS = 5000;

const STAGE_LABELS = {
  new_lead: "New Lead",
  quote_accepted: "Quote Accepted",
  follow_up: "Follow-Up",
  shopping: "Shopping Around",
  quote_sent: "Quote Sent",
  assigned: "Job Assigned",
  won: "Installed",
  not_reachable: "Not Reachable",
  out_of_area: "Out of Area",
};

function text(value, max = 500) {
  const clean = String(value == null ? "" : value).slice(0, max).trim();
  return /^[=+\-@]/.test(clean) ? `'${clean}` : clean;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function date(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function paymentDetails(lead) {
  const payment = lead && lead.payment;
  if (payment && payment.status === "paid") {
    return { status: "Paid", amount: number(payment.amount_paid_cents) / 100 };
  }
  if (payment) return { status: "Stripe link sent", amount: number(payment.amount_cents) / 100 };
  if (lead && lead.payment_preference === "phone") return { status: "Phone call requested", amount: null };
  return { status: "Not requested", amount: null };
}

function installationAddress(lead) {
  const locality = [text(lead.address_suburb, 100), text(lead.address_state, 20), text(lead.address_postcode, 12)].filter(Boolean).join(" ");
  return [text(lead.address_line1, 180), locality].filter(Boolean).join(", ");
}

module.exports = async (req, res) => {
  if ((req.headers["x-portal-key"] || "") !== PORTAL_KEY) return res.status(401).json({ error: "Invalid portal key" });
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const input = req.body || {};
  if (!Array.isArray(input.leads) || input.leads.length > MAX_ROWS) return res.status(400).json({ error: "Invalid lead export" });

  try {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "PowerSmart";
    workbook.created = new Date();
    const sheet = workbook.addWorksheet("Pipeline", { views: [{ state: "frozen", ySplit: 5 }] });
    sheet.mergeCells("A1:P1");
    sheet.getCell("A1").value = "PowerSmart Sales Pipeline";
    sheet.getCell("A1").font = { name: "Aptos Display", size: 18, bold: true, color: { argb: "FFFFFFFF" } };
    sheet.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0B1B1F" } };
    sheet.getCell("A1").alignment = { vertical: "middle" };
    sheet.getRow(1).height = 32;

    sheet.mergeCells("A2:P2");
    sheet.getCell("A2").value = `Exported ${new Date().toLocaleString("en-AU", { timeZone: "Australia/Sydney" })}`;
    sheet.getCell("A2").font = { name: "Aptos", size: 10, color: { argb: "FF41585D" } };
    sheet.mergeCells("A3:P3");
    const filters = Array.isArray(input.filters) ? input.filters.map((item) => text(item, 120)).filter(Boolean) : [];
    sheet.getCell("A3").value = filters.length ? `Filters: ${filters.join(", ")}` : "Filters: All leads";
    sheet.getCell("A3").font = { name: "Aptos", size: 10, italic: true, color: { argb: "FF6B8288" } };

    const columns = [
      { name: "Created", width: 20 }, { name: "Last activity", width: 20 }, { name: "Days idle", width: 11 },
      { name: "Customer", width: 24 }, { name: "Phone", width: 18 }, { name: "Email", width: 30 },
      { name: "Installation address", width: 42 }, { name: "Postcode", width: 12 }, { name: "Source", width: 18 }, { name: "Stage", width: 20 },
      { name: "Agent", width: 16 }, { name: "Quote reference", width: 17 }, { name: "Quote total", width: 15 },
      { name: "Payment status", width: 22 }, { name: "Payment amount", width: 17 }, { name: "Comments", width: 11 },
    ];
    sheet.columns = columns.map((column) => ({ width: column.width }));

    const rows = input.leads.map((lead) => {
      const payment = paymentDetails(lead);
      const updated = date(lead.updated_at);
      const daysIdle = updated ? Math.max(0, Math.floor((Date.now() - updated.getTime()) / 864e5)) : null;
      return [
        date(lead.created_at), updated, daysIdle, text(lead.name, 120), text(lead.phone, 60), text(lead.email, 254),
        installationAddress(lead), text(lead.postcode, 20), text(lead.source, 80), STAGE_LABELS[lead.stage] || text(lead.stage, 50), text(lead.agent, 120),
        text(lead.quote_ref, 40), number(lead.quote_total), payment.status, payment.amount, number(lead.comment_count) || 0,
      ];
    });

    sheet.addTable({
      name: "PipelineLeads",
      ref: "A5",
      headerRow: true,
      totalsRow: false,
      style: { theme: "TableStyleMedium2", showRowStripes: true },
      columns: columns.map((column) => ({ name: column.name, filterButton: true })),
      rows,
    });

    sheet.getColumn(1).numFmt = "dd/mm/yyyy h:mm AM/PM";
    sheet.getColumn(2).numFmt = "dd/mm/yyyy h:mm AM/PM";
    sheet.getColumn(13).numFmt = '"$"#,##0.00';
    sheet.getColumn(15).numFmt = '"$"#,##0.00';
    sheet.getRow(5).height = 24;
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber >= 5) row.alignment = { vertical: "middle", wrapText: false };
    });
    sheet.autoFilter = { from: "A5", to: "P5" };

    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="powersmart-pipeline-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    return res.status(200).send(Buffer.from(buffer));
  } catch (error) {
    console.error("pipeline export failed:", error.message);
    return res.status(500).json({ error: "Could not create the Excel file" });
  }
};
