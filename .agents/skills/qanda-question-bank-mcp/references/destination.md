# Choose the destination

Use `qanda_list_courses` to resolve the course, `qanda_list_banks(subjectId)` for its banks and `qanda_list_chapters(bankId)` for its chapters. Follow pagination for matches. Display names in course → bank → chapter order. Disambiguate duplicate names with their parent and returned identifiers.

Ask the user to select every missing level from actual candidates, even for a single match. A complete unambiguous path explicitly supplied for this import counts as their choice after verifying membership. With no matching chapter, report the missing destination and ask the user how to proceed. Do not infer consent from a filename, the package's labels or a previous task.

For a ZIP, inspect the manifest locally first. Show the mapping for every source chapter and the destination for each set of unassigned questions. Obtain the user's choices before uploading any bytes. Children inherit their reading group's chapter. If a destination changes, recheck membership and preview the revised mapping.
