# Excel workflow

Read this guide only for Excel output. Start from the bundled [question-bank template](../assets/question-bank-template.xlsx). It is a blank Qanda Excel 1.0 workbook for the `banks` resource and becomes importable after bank information and reviewed questions are filled in.

The [Excel import documentation](../../../../docs/excel-import-export.md) and the file-only [ExcelWorkbook codec](../../../../apps/api/src/main/kotlin/qanda/backend/excel/ExcelWorkbook.kt) own the current contract. Check them when field behavior or compatibility is uncertain. The template's Chinese sheet names, header cells, and version marker are protocol literals; preserve them exactly. This guide uses English sheet roles and one-based template positions to describe them.

## Populate the bundled template

Copy the workbook into the job's output directory and edit the copy with an available spreadsheet tool. Use one workbook per bank, splitting large banks only at complete question/group boundaries.

1. Generate a file ID matching `[A-Za-z0-9_.-]{1,80}` for each prepared workbook. Replace the template ID in sheet 1 cell `A3` and sheet 2 cell `A2` with the same value. Keep it stable for retries of that file; give separate workbooks distinct IDs.
2. Preserve sheet 1 cell `A1`, every sheet name, and every data-sheet header and column order. Fill data from row 2 onward. Sheet 2 must contain exactly one bank-information row.
3. Store every populated cell as an Excel string, including IDs, order values, Boolean text, and answers. Apply text number format when extending the template. A display format alone does not convert a numeric or Boolean cell to a string. Keep literal text beginning with `=` as text; formulas, macros, and external workbook links are rejected.
4. Leave system-ID columns empty for new content. Use `MARKDOWN`, an explicit presentation, and `ACTIVE` for prepared questions. Leave the code-language column empty; specify the language in Markdown fences.

## Sheet and field mapping

The ordered field names below are codec keys. They describe existing columns A onward; they are not replacement headers.

| Sheet | Role | Fields in column order |
| --- | --- | --- |
| 1 | Instructions | `A1`: version/resource marker; `A2`: file-ID label; `A3`: file ID. Remaining rows contain guidance. |
| 2 | Bank information | `id`, `subject`, `name`, `description`, `textbook`, `systemId` |
| 3 | Chapters | `id`, `name`, `sortOrder` |
| 4 | Questions | `id`, `chapterId`, `parent`, `type`, `stem`, `correctAnswer`, `correctValue`, `referenceAnswer`, `explanation`, `passage`, `contentFormat`, `presentation`, `codeLanguage`, `status`, `systemId` |
| 5 | Options | `question`, `key`, `content` |
| 6 | Blank answers | `question`, `blank`, `answer`, `ignoreCase`, `trimWhitespace` |
| 7 | Reference points | `question`, `content` |
| 8 | Provenance | `question`, `content` |
| 9 | Attachments | `id`, `path`, `question` |
| 10 | Long text | `sheet`, `record`, `field`, `part`, `content` |

- Bank information: fill the bank name and known course, description, and textbook. If the target course is not known, resolve it during Admin preview rather than inventing a course. File preparation does not create catalog entries.
- Chapters: use stable local IDs and distinct nonnegative order values, written as strings. Question chapter IDs reference these rows.
- Choice answers: write one key for single choice and comma-separated keys such as `A,C` for multiple choice. Each option occupies one row in sheet 5.
- Judgment answers: write the strings `true` or `false` in sheet 4 column G.
- Fill blanks: write one candidate per row in sheet 6; blank numbers start at 1 and are consecutive. Write explicit `true`/`false` strings in both matching columns and keep the settings identical for every answer of the same question.
- Short answers: put the reference answer in sheet 4 column H and each optional reference point in its own sheet 7 row.
- Reading: write one parent row with type `READING` and the passage in column J. Each child is another question row whose column C references the parent ID. Preserve child order and leave child chapter cells empty so the group inherits the parent's chapter.
- Provenance: sheet 8 column B contains serialized JSON, one row per question, reading parent, or child. Preserve `origin`, `sourceRefs`, and `ai` from the shared content model. Identify source files and locations in the review report so local source IDs remain resolvable.
- Attachments: use relative `assets/...` paths. Each row links one asset ID/path to a question ID. Reusing an asset requires the same path for that asset ID. Deliver the actual referenced image files.

## Long text

If a field exceeds 30000 UTF-16 code units or 200 newline characters, move its entire value to sheet 10 and leave the ordinary cell empty. Split into chunks within both limits, preserving characters, newline positions, and surrogate pairs. The reader joins chunks directly without adding separators.

- `sheet`: the exact target sheet name from the template.
- `record`: the row's `id` when present; for options use `option:<question-id>:<option-key>`; for other related rows use `row:<one-based-Excel-row>`.
- `field`: the codec key from the mapping table, not the displayed header.
- `part`: consecutive strings `1`, `2`, and so on for that target field.
- `content`: the unchanged chunk.

Finalize related-row positions before writing `row:` references. After a reorder, update affected references and verify the reconstructed text.

## Validate and deliver

- Read the saved workbook through `ExcelWorkbook.read(bytes, "banks")`, or use the Admin Excel preview when an authorized session is available. Compare the restored bank, chapters, question/child counts and order, answers, full explanations, provenance, and attachment references with the prepared content. Check long-text reconstruction when used.
- Apply the repository's question-content validation as well. An internal v1.0 JSON representation can use the existing `apps/admin/scripts/validate-question-bank.mjs` validator; it is working data for Excel delivery. A workbook codec read alone does not establish backend content validity or educational correctness.
- Preview in Admin verifies course/chapter mappings and current backend constraints. Record whether offline checks, Admin preview, or both actually ran. Resolve reported failures; state any unavailable validation before describing readiness.
- Each batch allows at most 20 workbooks, 3000 answerable items, and 8 MiB normalized content. HTTP uploads total at most 8 MiB. Keep reading groups intact. Each image must be PNG, JPEG, or WebP and at most 5 MiB.
- Deliver `.xlsx` files, referenced images, and the Chinese review report. For Admin upload, select the workbooks and images together or package only those import files in a ZIP with their relative paths preserved. Keep the review report alongside the upload ZIP, since the upload accepts workbooks and images.

The Admin workflow is Excel import, preview and validation, course or target-bank selection, chapter mapping, confirmation, then publication after checks. Imports add records; stable file IDs support retries, while conflicts require correction. A prepared workbook does not establish successful import or publication.
