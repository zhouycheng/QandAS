---
name: qanda-question-bank
description: Extract or author Qanda question banks from source materials for Admin import. Offer Excel (default) or JSON, then prepare questions, Chinese teaching explanations, provenance, attachments, and a review report in the selected format.
---

# Qanda question-bank preparation

## Choose the output format first

Before extracting, authoring, or transforming questions, establish the format for the current job.

- If the user has already chosen Excel or JSON for this job, use that choice. Apply a later explicit change immediately.
- Otherwise, ask one short question in the user's language with two choices: **Excel (.xlsx, recommended default)** and **JSON (.json)**. Use the available user-input tool; put Excel first and preselect it when supported.
- Wait for the answer before processing the material. A response accepting the default selects Excel; silence or elapsed time does not select a format. If no question tool is available, ask in chat and wait.

The format question applies to question-bank preparation, not to requests to explain or edit this skill.

## Load only the selected workflow

Resolve links relative to this file. After the format is established, read [content preparation](references/content.md) and the matching format guide:

| Selected format | Read | Starting asset |
| --- | --- | --- |
| Excel | [Excel workflow](references/excel.md) | [Bundled workbook template](assets/question-bank-template.xlsx) |
| JSON | [JSON workflow](references/json.md) | Repository JSON template linked by that guide |

Load the other format guide only when the user changes format or requests both. Inspect input-specific document, OCR, spreadsheet, web, or transcription tools as needed by the supplied material.

## Prepare, verify, and deliver

1. Inventory and read the supplied sources, preserving page, cell, slide, region, URL, or timestamp locations and necessary images.
2. Extract original questions or author questions from knowledge material. Preserve chapter and reading-group relationships and identify AI additions.
3. Write a fresh Chinese teaching explanation for every answerable item. Independently solve and review each item using the content guide.
4. Put unresolved items in the review report with their source locations and reasons. Include resolved items in the selected import format.
5. Apply the selected format's validation and attachment checks. Fix failures and rerun the affected checks. Structural validation and educational review are separate evidence.
6. Deliver the selected files, referenced `assets/`, and a Chinese review report in the requested output directory, or a clearly named project output directory. Preserve original inputs and keep credentials, private machine paths, and unrelated source material out of the package.

The report includes actual source coverage; counts by type and extracted/authored origin; AI additions; unresolved exclusions; validation evidence; remaining manual checks; and the selected format's Admin import steps. Count reading children as answerable questions and keep each reading group intact when splitting batches.

Preparing a package ends with delivery. Importing or publishing requires the user's corresponding instruction. Report those states only when actually observed.
