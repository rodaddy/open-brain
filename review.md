The changes to add `total_count` and pagination metadata (`has_more`) to the response format are well-implemented. The SQL logic for `buildCountSelect` and the use of `Promise.all` for executing the data and count queries in parallel are correct and efficient.

However, there is a significant issue with duplicating constants that needs to be addressed before merging:

1. **Code Duplication & Regression:**
   You have manually copied `ALL_TABLES`, `SOURCE_LABELS`, `CONTENT_PREVIEW`, and `TABLE_ALIAS` directly into `list-recent.ts` instead of continuing to import them from `table-constants.ts`. 

   By doing this, you've introduced a regression because the copied versions of `CONTENT_PREVIEW` are missing the robust null-handling and formatting present in `table-constants.ts`. 
   
   For instance, in the duplicated code:
   ```typescript
   decisions: "d.title || ': ' || d.rationale",
   ```
   In PostgreSQL, concatenating a string with `NULL` results in `NULL`. If `d.rationale` is null, the entire preview will be `NULL`. The original version in `table-constants.ts` correctly uses `COALESCE(d.rationale, '')`.

   Similarly, the duplicated `sessions` preview lacks the richer formatting for `key_decisions` and `next_steps` that was added in `table-constants.ts`.

**Action Items:**
- Revert the manual definitions of `ALL_TABLES`, `SOURCE_LABELS`, `CONTENT_PREVIEW`, and `TABLE_ALIAS` in `list-recent.ts`.
- Restore the import from `./table-constants.ts` to ensure consistency with `search-brain.ts` and prevent null-concatenation bugs.
