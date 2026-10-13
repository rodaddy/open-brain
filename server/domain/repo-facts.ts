// The repo-fact model surface: one import site for the vocabulary, schema, and
// pure helpers that live in ./repo-facts-model.ts and ./repo-facts-source-urls.ts
// (issue 864). MCP registration for repo facts belongs to the tools tier --
// registerRepoFactTools in ../tools/repo-facts.ts, wired at ../tools/index.ts --
// and the two superseded registrars that used to sit here were deleted with it
// (issue 1212).

// The vocabulary, schema, contracts, and pure helpers keep one import site for
// callers, exactly as they had when all of this lived in one file.
export * from "./repo-facts-model.ts";
