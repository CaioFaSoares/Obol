// D009 follow-up: the BFF registry was created as `sessions`, which is a
// reserved name in PocketBase (PocketBase v0.40 ships a built-in system
// collection named `sessions`). Migration 1700000011 therefore resolved to
// PocketBase's built-in collection on fresh installs and silently skipped
// creating the real registry. Rename the internal persistence table to
// `obol_sessions`; the BFF HTTP route contract is unchanged. All rules null:
// the collection is created, read, updated and deleted only by the BFF
// superuser at runtime; clients never reach PocketBase directly.
migrate((app) => {
  try {
    app.findCollectionByNameOrId("obol_sessions");
    return;
  } catch (_) {
    // First run: create the collection below.
  }

  // D010: create only the skeleton for the custom-named collection. The BFF
  // registry was created as `sessions`, which is a reserved name in
  // PocketBase (v0.40 ships a built-in system collection named `sessions`),
  // so it lives in `obol_sessions` instead; the BFF HTTP route contract is
  // unchanged. All rules null: only the BFF superuser touches PocketBase.
  //
  // Under the pinned PocketBase 0.40.6 runtime, inline field definitions
  // declared on a collection constructor are not persisted at this stage:
  // the collection is saved with only the standard system `id` field. Any
  // index referencing those inline fields (e.g. idx_obol_sessions_expiresAt)
  // then fails with `no such column: expiresAt`, which aborts this migration
  // as failed and prevents every later migration from running. Therefore
  // this migration only creates a bare base collection (no fields/indexes);
  // migration 1700000015 adds the real columns and index afterwards via
  // `fields.add`, which persists correctly.
  try {
    app.findCollectionByNameOrId("obol_sessions");
    return;
  } catch (_) {
    // First run: create the collection below.
  }

  const obolSessions = new Collection({
    name: "obol_sessions",
    type: "base",
    system: false,
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
  });

  app.save(obolSessions);
}, (app) => {
  // Drop only our custom collection; never touch PocketBase's reserved
  // `sessions` collection.
  try {
    const obolSessions = app.findCollectionByNameOrId("obol_sessions");
    app.delete(obolSessions);
  } catch (_) {
    // Already absent: nothing to drop.
  }
});
