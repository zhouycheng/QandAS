---
name: qanda-question-bank
description: Prepare reviewed Qanda questions from PDF, Word, spreadsheets, legacy JSON, images or other teaching materials. Produce a structured single question or a portable bank ZIP.
---

# Prepare questions

Read [content preparation](references/content.md). Inspect the supplied material, extract necessary images, independently solve each question and preserve its source location. Use the six supported question types. Document any AI additions and unresolved items in a Chinese review report.

When invoked for a single question or reading group, return its validated content, stable portable ID, source records and referenced images to the calling workflow. For a collection, prepare UTF-8 `bank.json` with format `qanda-question-bank` and version `1.0`. Use the bundled schema and six-type example. Assign each question and child a stable UUID and preserve these IDs when editing.

Place referenced PNG, JPEG or WebP images under `assets/images/`. Use `![description](asset:image-id)` at the intended position in Markdown. Keep video references as HTTPS links. The package may include `review-report.md`.

In the remote or downloadable distribution use `schema.json` and `examples/six-types.json`, then run `node scripts/validate.cjs /path/to/bank.json`. In the project checkout these two references live under `docs/question-bank-import/`; run `npm --prefix apps/admin run validate:bank -- /path/to/bank.json`. For a single question, validate a one-question manifest with its source and image records before returning the structured question. For a bank, archive bank.json, referenced images and the optional report at the ZIP root.
