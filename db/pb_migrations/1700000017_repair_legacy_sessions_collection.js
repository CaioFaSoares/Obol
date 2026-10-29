// Repair for the custom `sessions` collection left behind by the failed
// migration 0011. On a fresh PocketBase 0.40.6 boot, 0011's constructor
// created the collection but failed while building its indexes
// ("no such column: expiresAt" — SQLite checks index columns at execution
// time, before fields persisted), so 0011 keeps retrying and failing on
// every startup, leaving a bare `sessions` collection with only `id`.
//
// This migration is orphan compatibility debris: the BFF now reads
// `obol_sessions` exclusively (see 0014-0016). Its only job is to bring the
// damaged legacy collection to the shape 0011 expects, created additively so
// any rows from the partial create are preserved without fabricated values
// (all added fields are optional). Once this migration runs, 0011's
// early-return sees an existing `sessions` collection and records itself as
// applied on the next startup, ending the retry loop.
//
// Guards: reject a same-named field with an incompatible type, and reject a
// system collection outright — a PocketBase built-in `sessions` (if a future
// version ever adds one) must never be mutated here.
migrate((app) => {
  let sessions;
  try {
    sessions = app.findCollectionByNameOrId("sessions");
  } catch (_) {
    // Missing entirely (e.g. 0011's down dropped it): recreate a bare
    // custom base collection and repair that one.
    sessions = new Collection({
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
  }

  if (sessions.system) {
    throw new Error(
      "sessions exists as a PocketBase system collection; refusing to mutate it"
    );
  }

  const owner = app.findCollectionByNameOrId("owner");

  // Guard against a same-named field with an incompatible type: silently
  // accepting it would leave a malformed schema behind.
  const assertExpectedType = (name, expected) => {
    const actual = (() => {
      try {
        return sessions.fields.getByName(name).type;
      } catch (_) {
        return null; // absent, safe to add
      }
    })();

    if (actual !== null && actual !== expected) {
      throw new Error(
        "fields.add: sessions." + name + " exists with incompatible type " +
          actual + " (expected " + expected + ")"
      );
    }

    if (actual === null) {
      sessions.fields.add(expected === "relation" ? new RelationField({
        name,
        required: false, // optional: preserve partial-create rows
        collectionId: owner.id,
        cascadeDelete: true,
        maxSelect: 1,
      }) : expected === "date" ? new DateField({
        name,
        required: false,
      }) : new TextField({
        name,
        required: false,
        max: 100,
      }));
    }
  };

  assertExpectedType("userId", "relation");
  assertExpectedType("expiresAt", "date");
  assertExpectedType("deviceLabel", "text");

  const indexStatement =
    "CREATE INDEX idx_sessions_expiresAt ON sessions (expiresAt)";
  const indexPresent = sessions.indexes.some(
    (idx) => idx.includes("idx_sessions_expiresAt")
  );
  if (!indexPresent) {
    sessions.indexes.push(indexStatement);
  }

  app.save(sessions);
}, (app) => {
  // Intentionally non-destructive no-op: this collection is orphan
  // compatibility debris kept so 0011 stays resolvable, and dropping rows,
  // fields, or the index on rollback would only destroy legacy data.
});
