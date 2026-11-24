// Shared inspection-only wording for the acceptance page, email and PDF.
(function (root) {
  const wording = {
    VERSION: "v3",
    SUBTITLE: "If you choose PowerSmart smoke alarm installation",
    HEADLINE: "If you proceed with our smoke alarm installation",
    LEAD: "If you wish to proceed with our smoke alarm supply and installation, this is how our alarm care service works. It applies only to alarms supplied and installed by PowerSmart. An inspection-only visit does not provide warranty or replacement cover for your existing alarms.",
    SITUATION: "If an alarm supplied and installed by PowerSmart is faulty, or sounds or chirps for no obvious reason",
    TICK: "I've read and understand how alarm care would apply if I proceed with PowerSmart's smoke alarm supply and installation.",
    KEEP_NOTE: "This notice explains care for an optional future PowerSmart smoke alarm installation. Keep it for reference if you choose to proceed. It does not confirm that PowerSmart has installed or warranted your existing alarms."
  };
  if (typeof module !== "undefined" && module.exports) module.exports = wording;
  else root.PSInspectionCare = wording;
})(typeof window !== "undefined" ? window : this);
