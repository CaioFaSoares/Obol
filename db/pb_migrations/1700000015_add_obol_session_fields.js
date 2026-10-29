// D009 repair for the custom `obol_sessions` collection. The 0014 constructor
// field array did not persist its fields in the production runtime, so login
// fails and the collection is left with only the system `id`. This migration
// loads the existing collection and adds every expected field only when
// absent, mirroring the project's `collection.fields.add(...)` convention
// (see 0001-0009) instead of re-running 0014's constructor.
//
// The down migration is deliberately a no-op: this migration repairs the
// production data shape, and dropping the fields/rows on rollback would break
// authentication. The registry fields and session rows must survive any
// application-side rollback.
migrate((app) => {
  const sessions = app.findCollectionByNameOrId("obol_sessions");
  const owner = app.findCollectionByNameOrId("owner");

  // Guard against a same-named field with an incompatible type: silently
  // accepting it would leave a malformed schema behind.
  const typeFor = (name) => {
    try {
      return sessions.fields.getByName(name).type;
    } catch (_) {
      return null; // absent, safe to add
    }
  };

  const assertExpectedType = (name, expected) => {
    const actual = typeFor(name);
    if (actual !== null && actual !== expected) {
      throw new Error(
        "fields.add: obol_sessions." + name + " exists with incompatible type " +
          actual + " (expected " + expected + ")"
      );
    }

    if (actual === null) {
      sessions.fields.add(expected === "relation" ? new RelationField({
        name,
        required: true,
        collectionId: owner.id,
        cascadeDelete: true,
        maxSelect: 1,
      }) : expected === "date" ? new DateField({
        name,
        required: true,
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
    "CREATE INDEX idx_obol_sessions_expiresAt ON obol_sessions (expiresAt)";
  const indexPresent = sessions.indexes.some(
    (idx) => idx.includes("idx_obol_sessions_expiresAt")
  );
  if (!indexPresent) {
    sessions.indexes.push(indexStatement);
  }

  app.save(sessions);
}, (app) => {
  // Intentionally non-destructive: retain the `obol_sessions` fields and all
  // session rows on rollback so live sessions keep working. Any change here
  // would undo a production repair.
});
