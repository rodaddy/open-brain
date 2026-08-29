/**
 * Contract entries for repo-fact upsert and listing.
 */
import {
  REPO_FACT_METADATA_CONTRACT,
  REPO_FACT_VALIDATION_CONTRACT,
} from "../../src/tools/repo-facts.ts";
import type { ToolContract } from "./tool-contract.ts";

export const REPO_FACT_TOOL_CONTRACTS: Record<string, ToolContract> = {
  upsert_repo_fact: {
    version: 2,
    input_schema: {
      namespace: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Memory partition to write the fact into. Defaults to your own " +
          "auth-derived namespace; override only when authorized (e.g. " +
          "promoting into shared-kb).",
      },
      metadata: REPO_FACT_METADATA_CONTRACT,
      validation: REPO_FACT_VALIDATION_CONTRACT,
    },
    output_shape: "ob_entities repo_fact row JSON text payload",
  },
  list_repo_facts: {
    version: 2,
    input_schema: {
      namespace: {
        type: "string",
        required: false,
        maxLength: 500,
        description:
          "Memory partition to read facts from. Defaults to your own " +
          "auth-derived namespace; override only when authorized for another.",
      },
      repo: {
        type: "string",
        required: false,
        maxLength: 300,
        description: "Filter to facts about this repository slug (e.g. owner/repo).",
      },
      collection: {
        type: "string",
        required: false,
        maxLength: 300,
        description: "Filter to facts derived from this qmd collection.",
      },
      path: {
        type: "string",
        required: false,
        maxLength: 1000,
        description: "Filter to facts about this repo-relative file path.",
      },
      fact_type: {
        type: "enum",
        required: false,
        values: REPO_FACT_METADATA_CONTRACT.fact_type.values,
        description: "Filter to one fact category. Omit to return all types.",
      },
      subject: {
        type: "string",
        required: false,
        maxLength: 500,
        description: "Filter to facts whose subject/symbol matches this value.",
      },
      limit: {
        type: "integer",
        required: false,
        min: 1,
        max: 250,
        description: "Maximum facts to return (1-250). Keep small for focused recall.",
      },
      offset: {
        type: "integer",
        required: false,
        min: 0,
        description:
          "Number of facts to skip, for paging. Leave at 0 for the first " + "page.",
      },
    },
    output_shape: "repo_fact ob_entities row array JSON text payload",
  },
};
