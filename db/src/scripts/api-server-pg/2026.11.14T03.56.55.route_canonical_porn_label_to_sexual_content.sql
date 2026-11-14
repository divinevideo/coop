-- ABOUTME: Adds the canonical `porn` label and the detector's `hentai` class to the
-- ABOUTME: Sexual Content routing rule so classifier evidence stops landing in General Review.
-- Route the canonical `porn` label, and the nsfw detector's `hentai` class,
-- to the Sexual Content queue.
--
-- Divine's canonical moderation vocabulary treats `porn` as the label and
-- `pornography` / `explicit` as aliases of it (divine-moderation-service
-- src/moderation/vocabulary.mjs). The `label_value -> Sexual Content` routing
-- rule matched only the aliases, so items labelled with the canonical value --
-- every `ai_detector_nsfw` item Osprey submits, whose label_value is the
-- detector class -- fell through to `nostr_event -> General Review`.
--
-- Data only, and scoped to the one rule by name and input field. Orgs that do
-- not have this rule (local, test, staging seeds) are untouched. Re-running is
-- a no-op once `^porn$` is present. The row-level versioning trigger records
-- the previous condition_set in routing_rule_history, and the statement-level
-- trigger refreshes routing_rule_versions, exactly as an edit through the UI.
--
-- Rollback: remove the two values with the inverse jsonb update, or restore the
-- prior condition_set from manual_review_tool.routing_rule_history.
UPDATE manual_review_tool.routing_rules
SET condition_set = jsonb_set(
        condition_set,
        '{conditions,0,matchingValues,strings}',
        (condition_set #> '{conditions,0,matchingValues,strings}') || '["^porn$", "^hentai$"]'::jsonb
    )
WHERE name = 'label_value -> Sexual Content'
  AND jsonb_array_length(condition_set -> 'conditions') = 1
  AND condition_set #>> '{conditions,0,input,name}' = 'label_value'
  AND condition_set #>> '{conditions,0,signal,type}' = 'TEXT_MATCHING_CONTAINS_REGEX'
  AND NOT (condition_set #> '{conditions,0,matchingValues,strings}') @> '["^porn$"]'::jsonb;
