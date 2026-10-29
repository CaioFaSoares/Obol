// Adds the app-owned `createdAt` DateField to `obol_sessions`. PocketBase base
// collections created by migrations in this version do not auto-inject the
// system `created`/`updated` fields, only `id`; previously the session hard
// cap had to derive a timestamp from a value that was never persisted. This
// migration provides a durable, immutable persisted timestamp instead. The
// field is optionally so that already-existing session rows (which predate it)
// migrate without invented timestamps; new session creations always populate
// it. Down is a no-op: removing the field or backfilling/deleting rows would
// break live sessions and their hard-expiry semantics.
migrate((app) => {
  const sessions = app.findCollectionByNameOrId("obol_sessions");

  let existing = null;
  try {
    existing = sessions.fields.getByName("createdAt");
  } catch (_) {
    // absent, safe to add
  }

  if (existing !== null) {
    if (existing.type !== "date") {
      throw new Error(
        "fields.add: obol_sessions.createdAt exists with incompatible type " +
          existing.type + " (expected date)"
      );
    }
    // Already present as a date; idempotent no-op. Do not save unless needed.
    return;
  }

  sessions.fields.add(new DateField({
    name: "createdAt",
    required: false,
  }));

  app.save(sessions);
}, (app) => {
  // Intentionally non-destructive: keep the `createdAt` field and all session
  // rows on rollback so live sessions and their hard-expiry semantics survive
  // any application-side rollback.
});
