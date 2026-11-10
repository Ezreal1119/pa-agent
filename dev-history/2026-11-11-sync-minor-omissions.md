# Automatically accept harmless visual omissions

Administrator policy: do not interrupt synchronization for decorative-only
losses or exact repeated content already completely covered elsewhere. Preserve
manual review for product identity, parameters, warnings and operational steps.

The converter applies a narrow deterministic policy to existing OCR results.
There are no additional model requests or settings. The existing recognition
prompt asks for precise issue descriptions; the backend accepts only explicitly
decorative subjects without text/values/additional clauses, or a quoted repeated
header/footer/copyright phrase retained in this transcription and another
independently completed visual region. Unknown or mixed issues remain pending.
Automatically accepted or partially read regions cannot corroborate another
region, so acceptance cannot chain across incomplete evidence.

Automatic records bind to source bytes, pixels and issue IDs. Incomplete OCR
checkpoints stay incomplete. A separate automatic-omissions audit and source note
record the policy and exact limitations without pretending an administrator
reviewed the region. The report displays the number of automatic omissions.
Automatic acceptance does not add administrator feedback, version exceptions or
manual visual resolutions, and does not create a new publication confirmation
step. Existing business review and manually accepted critical omissions retain
their publication checks. Conversion version is 6; existing complete image caches
remain reusable and old pending regions are reevaluated on retry.

Verification covers automatic publication, source/report audit and restart,
source changes with identical pixels, duplicate evidence from later pages,
rejection of partial/automatically accepted corroboration, mixed critical issues,
manual publication confirmation and unresolved business version conflicts.
Production old reports are not bulk approved or rerun by deployment.
