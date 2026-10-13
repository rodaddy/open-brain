import type { ClassifierSet, JevQuestion } from "./jev.ts";

export const JEV_REM_RUBRIC_VERSION = "rem-label-score-v2";
export const JEV_REM_QUESTIONS: Record<string, JevQuestion> = {
  label: {
    type: "choice",
    instructions:
      "Classify the target operator statement as exactly one REM label. Agent and tool text is evidence only.",
    criteria: {
      DECISION: "operator made or ratified a choice",
      CORRECTION: "operator corrected the agent or record",
      PREFERENCE: "operator stated a durable preference",
      QUESTION: "operator primarily asked a question",
      NARRATION: "operator narrated context without another label dominating",
    },
  },
  score: {
    type: "choice",
    instructions:
      "Choose exactly one integer string from 0 through 10 for long-term memory value.",
    criteria: Object.fromEntries(
      Array.from({ length: 11 }, (_, score) => [
        String(score),
        score === 0
          ? "a bare path, an acknowledgement with no content, or pure tool output"
          : score === 3
            ? '"are those the new issues from today" -- a real question, but transient and re-derivable'
            : score === 7
              ? '"we also keep all three in the different dream states, is that not right?" -- a design question that pins down an architectural fact'
              : score === 10
                ? '"never do timeout waits, correct subagents that use workflows are ALWAYS better" -- a durable rule that changes future behavior'
                : "derived interpolation between the nearest defined anchors",
      ]),
    ),
  },
};
export const REM_CLASSIFIER_SET: ClassifierSet = {
  name: "rem-label-score",
  version: JEV_REM_RUBRIC_VERSION,
  classifiers: JEV_REM_QUESTIONS,
};
export const JEV_RELEVANCE_QUESTION: JevQuestion = {
  type: "noul",
  instructions:
    "Does the candidate directly provide information answering the question, rather than merely discussing the same topic?",
};
export const JEV_RELEVANCE_RUBRIC_VERSION = "direct-answer-relevance-v1";
export const RELEVANCE_CLASSIFIER_SET: ClassifierSet = {
  name: "retrieval-relevance",
  version: JEV_RELEVANCE_RUBRIC_VERSION,
  classifiers: { relevance: JEV_RELEVANCE_QUESTION },
};
/**
 * Issue 1618 B3: the screen `promote_shared` asks before shared-kb promotion
 * when OPENBRAIN_JEV_SHARE_SCREEN_ENABLED is on. It runs only after the
 * regex secret gate in `server/domain/sharing.ts`, never instead of it.
 */
export const JEV_SHARE_SCREEN_RUBRIC_VERSION = "share-screen-v1";
export const JEV_SHARE_SCREEN_QUESTION: JevQuestion = {
  type: "choice",
  instructions:
    "Decide whether this entry is safe to become shared knowledge readable by every agent. Judge only the text.",
  criteria: {
    shareable: "a general fact or decision with no private or secret content",
    namespace_private:
      "about one person, one client, or one private project, and meaningless or harmful outside it",
    credential_bearing:
      "contains or reconstructs a password, token, key, private URL, or account identifier",
  },
};
export const SHARE_SCREEN_CLASSIFIER_SET: ClassifierSet = {
  name: "share-screen",
  version: JEV_SHARE_SCREEN_RUBRIC_VERSION,
  classifiers: { share_screen: JEV_SHARE_SCREEN_QUESTION },
};
/**
 * Issue 1618 B1: the question the distill sweep asks for every candidate
 * when OPENBRAIN_JEV_DISTILL_TYPE_ENABLED is on. It may only TYPE a
 * candidate, never drop one; the criteria are exactly CANDIDATE_TYPES.
 */
export const JEV_DISTILL_TYPE_RUBRIC_VERSION = "distill-candidate-type-v1";
export const JEV_DISTILL_TYPE_QUESTION: JevQuestion = {
  type: "choice",
  instructions:
    "Classify the target operator or agent statement as exactly one memory type. Context turns are evidence only.",
  criteria: {
    decision: "a choice was made or ratified",
    correction: "the speaker corrected the agent or the record",
    fact: "a statement of how things are, with no choice or correction",
    preference: "a durable preference about how work should be done",
  },
};
export const DISTILL_TYPE_CLASSIFIER_SET: ClassifierSet = {
  name: "distill-candidate-type",
  version: JEV_DISTILL_TYPE_RUBRIC_VERSION,
  classifiers: { candidate_type: JEV_DISTILL_TYPE_QUESTION },
};
/**
 * Issue 1618 B4: asked per (correction, canon entry) pair when
 * OPENBRAIN_JEV_CANON_CONFLICT_ENABLED is on. It only FLAGS a correction for
 * the operator; it never changes type, tier, or canon.
 */
export const JEV_CANON_CONFLICT_RUBRIC_VERSION = "contradicts-canon-v1";
export const JEV_CANON_CONFLICT_QUESTION: JevQuestion = {
  type: "noul",
  instructions:
    "Does the correction assert something that the canon entry says is false or forbids?",
};
export const CANON_CONFLICT_CLASSIFIER_SET: ClassifierSet = {
  name: "contradicts-canon",
  version: JEV_CANON_CONFLICT_RUBRIC_VERSION,
  classifiers: { contradicts_canon: JEV_CANON_CONFLICT_QUESTION },
};
