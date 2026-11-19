---
name: qanda-question-bank-mcp
description: Manage Qanda question banks through an authorized remote MCP connection. Use when an administrator supplies source materials, requests question edits, or imports a bank ZIP.
---

# Manage a question bank

Resolve the named bank and chapter through the connected tools. If multiple banks match, present their courses and names before writing. Discover the available tools and permissions for this connection.

For original material, use the companion `qanda-question-bank` skill from this server or the matching local installation. Activate it by name when the host offers a skill loader. In hosts that expose MCP skills as resources, read the companion SKILL.md and its referenced files, then carry out its preparation workflow in the current session. Preserve the source location, run its bundled validator, and use the resulting question or ZIP for the write. The workbench installation ZIP at the MCP origin's `/qanda-bank-skills.zip` contains the same validator and examples if the host cannot materialize resource files. Record missing or unreadable sources in the review.

For a single question or reading group, submit the reviewed structured question with `qanda_create_question`. For an edit, retrieve the current question and version, show the changed fields, obtain confirmation and use `qanda_update_question`. A reading group is one edit. Keep a stable idempotency key for retries of the same write.

For a collection, prepare the ZIP with the companion skill. For a supplied ZIP, proceed directly to the bank-bound upload and `qanda_preview_import`. Review counts, chapter matches, image checks and conflicts. A request to import authorizes new questions. Show differences for existing questions and obtain confirmation before `qanda_commit_import`. A changed bank version requires a fresh preview.

For one structured question, put the target bank UUID in both `bankId` and `input.questionBankId`. Use the companion's question ID as `input.portableId`, including `portableId` on children. Use the database chapter ID for `chapterId`. A new child omits its database `id`. For edits keep the child IDs returned by the detail tool and include `input.expectedVersion`. Copy the reviewed `provenance` and `sources` into the input. Use `qanda_upload_image` per image, PUT the raw file using its MIME type, then replace local image references in the text and `assetIds` with the returned image UUIDs.

For ZIP, call `qanda_upload_zip` with byte length, PUT consecutive 4 MiB chunks at the returned URL with zero-based `part`, then pass the upload ID inside `input` to preview. Commit with the same mapping, the returned digest, and `expectedContentVersion` from the preview. Set `confirmUpdates` only after confirmation.

Return the actual receipt, question and revision identifiers, skipped records, and unresolved source locations. Publish only when requested with the necessary grant. If the required tools or permissions are unavailable, return the prepared material and state the pending operation.
