# V1 to V2 Migration Guide

## Before migration

1. Stop V1 writers and keep the original state directory unchanged.
2. Register the live workspace through the local Project Registry. Record its opaque `project_id` and derived workspace id.
3. Run the full deterministic test suite and SQLite integrity check.
4. Choose a backup destination outside both the V1 state directory and the live V2 database path.

## Import contract

`V1StateMigrator` imports validated execution-record metadata, session metadata, and machine preferences into SQLite. It verifies that the registered root still has its original filesystem identity and that the supplied workspace id belongs to it. Inputs must be bounded regular files; symlinks, malformed records, changed or removed previously imported records, and cross-project attribution fail closed.

Execution-output bodies and records containing `outputId` or `outputAvailable: true` are not supported in this beta. Preserve those V1 files and treat `UNSUPPORTED_SOURCE` as a required manual migration decision; the importer does not discard or pretend to migrate them.

Each first import creates and verifies a SQLite backup before committing a uniquely keyed batch. Repeating identical input returns the original batch. Concurrent identical imports collapse to one durable batch.

## Rollback

Call `rollback(batchId)` while the V1 sources and recorded backup remain available. Rollback removes only metadata owned by that batch; Project Registry and unrelated V2 state remain. Verify SQLite integrity afterward. The backup path returned by the importer is canonical and is also stored with the batch.

Do not delete V1 state until the beta acceptance window completes. Compatibility commands remain explicit local adapters and are never a silent runtime fallback.
