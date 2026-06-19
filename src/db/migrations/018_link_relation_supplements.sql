-- Migration 018: Add 'supplements' to the ob_links relation allowlist.
-- Issue #173 (thought-cluster supplementation, piece (c) of the #161 design):
-- when the shared-kb promoter promotes a lane memory that RELATES to an existing
-- shared-kb thought cluster (near, but not an exact/near duplicate), it links the
-- new thought to the cluster anchor with relation 'supplements' rather than
-- dropping it as a dup or leaving it as an orphan. The CHECK lives inline on the
-- table (created in 010), so we drop and re-add it with the extra value.

ALTER TABLE ob_links DROP CONSTRAINT IF EXISTS ob_links_relation_check;

ALTER TABLE ob_links ADD CONSTRAINT ob_links_relation_check CHECK (relation IN (
  'artifact',
  'depends_on',
  'supersedes',
  'caused_by',
  'same_lane',
  'adjacent',
  'mentions',
  'implemented_by',
  'blocked_by',
  'decided_by',
  'relates_to',
  'contradicts',
  'duplicates',
  'supplements'
));
