// D009 requirement 2: base collection `sessions` with `userId` (cascade
// relation to `owner`, so deleting the owner truncates the registry and
// orphans can never authenticate), `expiresAt` (date, indexed) and
// `deviceLabel` (text). All rules null: the collection is created, read,
// updated and deleted only by the BFF superuser at runtime; clients never
// reach PocketBase directly.
migrate((app) => {
  try {
    app.findCollectionByNameOrId("sessions");
    return;
  } catch (_) {
    // First run: create the collection below.
  }

  const ownerCollection = app.findCollectionByNameOrId("owner");

  const sessions = new Collection({
    name: "sessions",
    type: "base",
    system: false,
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      new RelationField({
        name: "userId",
        required: true,
        collectionId: ownerCollection.id,
        cascadeDelete: true,
        maxSelect: 1,
      }),
      new DateField({
        name: "expiresAt",
        required: true,
      }),
      new TextField({
        name: "deviceLabel",
        required: false,
        max: 100,
      }),
    ],
    indexes: [
      "CREATE INDEX idx_sessions_expiresAt ON sessions (expiresAt)",
    ],
  });

  app.save(sessions);
}, (app) => {
  const sessions = app.findCollectionByNameOrId("sessions");
  app.delete(sessions);
});
