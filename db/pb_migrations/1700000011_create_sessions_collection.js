// D009 requirement 2: base collection `sessions` with `userId` (cascade
// relation to `owner`, so deleting the owner truncates the registry and
// orphans can never authenticate), `expiresAt` (date, indexed) and
// `deviceLabel` (text). All rules null: the collection is created, read,
// updated and deleted only by the BFF superuser at runtime; clients never
// reach PocketBase directly.
//
// The collection is created bare because PocketBase 0.40.6
// nondeterministically failed the inline-field create on fresh installs;
// migration 0017 adds the fields and index, which is the schema every
// successfully migrated deployment already has, see D017.
migrate((app) => {
  try {
    app.findCollectionByNameOrId("sessions");
    return;
  } catch (_) {
    // First run: create the bare collection below.
  }

  const sessions = new Collection({
    name: "sessions",
    type: "base",
    system: false,
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
  });

  app.save(sessions);
}, (app) => {
  const sessions = app.findCollectionByNameOrId("sessions");
  app.delete(sessions);
});
