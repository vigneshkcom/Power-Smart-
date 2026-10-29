# Pipeline follow-up update

Apply `pipeline-stable-order-and-not-interested.sql` before deploying this change.
It snapshots the current ordering without changing activity dates, then adds
the Not interested stage to the allowed database values. New leads receive a
position automatically. Subsequent edits, messages and notes retain that position.

The migration is transactional and can be reapplied without resetting positions.
The ordinary activity timestamp and its filters continue to work.
No lead stage changes or SMS sends are part of the migration.

After deployment, verify the stage in the pipeline filters, lead editor, quote
tracker and Excel labels. Verify a lead edit and board refresh preserve its
position. SMS templates are editable drafts and send only on Send SMS.
