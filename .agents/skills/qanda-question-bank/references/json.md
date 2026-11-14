# JSON workflow

Read this guide only for JSON output. Use the repository's existing portable v1.0 contract and validator.

## Load the contract

Read the [import specification](../../../../docs/question-bank-import.md), [JSON Schema](../../../../docs/question-bank-import/schema.json), and [six-type example](../../../../docs/question-bank-import/examples/six-types.json). Start from the [blank template](../../../../docs/question-bank-import/template.json); populate sources and questions before validation.

For code questions, load the [code example](../../../../docs/question-bank-import/examples/code-content.json). For image/table extraction, use the [image and table example](../../../../docs/question-bank-import/examples/image-and-table.json) and its actual source materials when needed.

## Serialize the content

- Set `format=qanda-question-bank` and `version=1.0`. Include `bank`, `sources`, `chapters`, `assets`, and `questions` with local identifiers and complete cross-references.
- Keep a reading group and its ordered `subQuestions` together. Children use the first five question types and share the file-wide question-ID namespace.
- Use a JSON Boolean for `correctValue`, arrays of option keys for `correctAnswer`, and `blanks[].answers` with explicit `blankMatch` settings for fill blanks.
- Preserve provenance on every question, reading parent, and child. Source IDs resolve through `sources`; asset IDs resolve through `assets` and actual files under `assets/`.
- Write UTF-8 JSON with one ordinary JSON encoding pass. Decode once to recover the intended text; preserve newlines, quotes, and backslashes without double encoding. Leave Markdown as Markdown.

## Validate and deliver

From the repository root, run:

```sh
npm --prefix apps/admin run validate:bank -- <absolute-path-to-bank.json>
```

Pass all files of a batch together so the shared limits are checked. This command reuses the Admin parser and verifies attached files. Fix reported errors and rerun. Also use the JSON Schema when an installed schema validator is available.

Each batch allows at most 20 JSON files, 3000 answerable items, and 8 MiB combined JSON. Reading children count separately; keep each group intact. Each image must be PNG, JPEG, or WebP and at most 5 MiB.

Deliver the JSON files, referenced `assets/`, and the Chinese review report. In Admin, choose the target bank, open batch import, select the JSON files, review the preview, map chapters, select/upload referenced images, and confirm import. Publication follows the bank's publication checks. The file's bank name does not create or rename a bank automatically.
