-- zele login no longer hands Google codes through zele.sh: the CLI uses a loopback redirect.
-- Dropping the table also drops oauth_handoff_expires_at_idx.
DROP TABLE IF EXISTS `oauth_handoff`;
