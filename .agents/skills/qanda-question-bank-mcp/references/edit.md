# Edit an existing question

Fetch `qanda_get_question(questionId)` and verify bank ownership. Review changed content using the preparation skill. Show the field differences, including changes to children, and obtain confirmation before writing. If uploading a new image, confirm the destination and follow the image transfer in [question creation](question.md).

Send one `qanda_update_question` per question or complete reading group, with `confirmed: true`, matching bank IDs and `input.expectedVersion` from the detail. Preserve existing child database IDs, portable IDs and source records. Keep the same idempotency key for an identical retry. On a version conflict, reload the detail and confirm the new diff.
