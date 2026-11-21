# Create one question or reading group

Validate a one-question manifest using the preparation skill. Put the selected bank UUID in both `bankId` and `input.questionBankId`, the database chapter UUID in `input.chapterId`, and each manifest question ID in its corresponding `portableId`. Include reviewed provenance and sources.

After destination confirmation, call `qanda_upload_image` for each referenced image and PUT the raw bytes with its MIME type. Replace each local asset key in Markdown and attachment lists with the returned image UUID. Check references in options, explanations, passages and children.

Call `qanda_create_question` with the flat input and a stable idempotency key for retries of this exact write. Submit a reading parent and ordered children together. New children omit database IDs and chapter IDs.
