// D016 / canon §12.4 typed fields for the sync and station collections.
// Migration 1700000018 created only the collection shells because PocketBase
// 0.40.6 does not persist constructor-declared fields. This migration adds
// every field with `fields.add` on the saved collection, following the
// 0014-0017 repair pattern.
//
// Requiredness follows PocketBase field semantics, not just the contract
// wording:
//   - `required` on a number field rejects 0, and on a text field rejects "".
//     `lastSeq` (genesis 0), `commitIndex` (0-based) and `headHash`/`prevHash`
//     (empty genesis hash) therefore stay optional at the schema level; the
//     BFF still always writes them.
//   - `required` on a JSON field rejects `null`, `""`, `[]` and `{}`. Optional
//     JSON fields use `required: false` so delete events can store
//     `record = null` and creates can store empty `payload`/`baseRevisions`.
//   - Integers are constrained with `onlyInt` and the domain minima; select
//     fields carry the exact contract values.
//
// Up is idempotent: an existing field of the expected type is kept as is, and
// only missing fields are added. A same-named field of a different type
// aborts the migration instead of leaving a malformed schema. Errors from
// `save` are never caught or swallowed. Down removes exactly these fields.
const SYNC_FIELD_SPECS = {
  obol_sync_meta: [
    { name: "serverInstanceId", type: "text", required: true },
    { name: "dataEpoch", type: "number", required: true, onlyInt: true, min: 1 },
    { name: "protocolMin", type: "number", required: true, onlyInt: true, min: 1 },
    { name: "protocolMax", type: "number", required: true, onlyInt: true, min: 1 },
    // Genesis journal state is lastSeq = 0; number `required` would reject it.
    { name: "lastSeq", type: "number", required: false, onlyInt: true, min: 0 },
    // The genesis head hash is the empty string (D016 D4/D16 rule 9).
    { name: "headHash", type: "text", required: false },
    { name: "journalBackfilledAt", type: "date", required: false },
    { name: "journalBackfillVersion", type: "number", required: false, onlyInt: true, min: 1 },
  ],
  obol_sync_entity_versions: [
    { name: "entityType", type: "text", required: true },
    { name: "entityId", type: "text", required: true },
    { name: "revision", type: "number", required: true, onlyInt: true, min: 1 },
    { name: "deleted", type: "bool", required: false },
    { name: "lastSeq", type: "number", required: false, onlyInt: true, min: 0 },
  ],
  obol_sync_changes: [
    { name: "seq", type: "number", required: true, onlyInt: true, min: 1 },
    { name: "commitId", type: "text", required: true },
    // commitIndex is 0-based: 0 is the first event of every commit.
    { name: "commitIndex", type: "number", required: false, onlyInt: true, min: 0 },
    { name: "commitSize", type: "number", required: true, onlyInt: true, min: 1 },
    { name: "kind", type: "select", required: true, values: ["upsert", "delete"] },
    { name: "entityType", type: "text", required: true },
    { name: "entityId", type: "text", required: true },
    { name: "revision", type: "number", required: true, onlyInt: true, min: 1 },
    // `record` is null for a delete tombstone.
    { name: "record", type: "json", required: false },
    {
      name: "origin",
      type: "select",
      required: true,
      values: ["station", "web", "job", "admin", "sync", "seed"],
    },
    { name: "stationId", type: "text", required: false },
    { name: "opId", type: "text", required: false },
    { name: "eventKey", type: "text", required: false },
    { name: "createdAt", type: "date", required: true },
    // The first event has an empty prevHash.
    { name: "prevHash", type: "text", required: false },
    { name: "chainHash", type: "text", required: true },
  ],
  obol_sync_operations: [
    { name: "opId", type: "text", required: true },
    { name: "stationId", type: "text", required: true },
    { name: "protocolVersion", type: "number", required: true, onlyInt: true, min: 1 },
    { name: "type", type: "text", required: true },
    { name: "entityType", type: "text", required: true },
    { name: "entityId", type: "text", required: true },
    // Some operation payloads are legitimately empty objects.
    { name: "payload", type: "json", required: false },
    // Complete-envelope hash (D016 D2 rule 9), not a payload-only hash.
    { name: "payloadHash", type: "text", required: true },
    // A create operation declares no base revisions: {} is valid.
    { name: "baseRevisions", type: "json", required: false },
    { name: "dependsOn", type: "json", required: false },
    { name: "effectiveAt", type: "date", required: true },
    { name: "clientCreatedAt", type: "date", required: true },
    { name: "status", type: "select", required: true, values: ["accepted", "conflict", "rejected"] },
    { name: "result", type: "json", required: false },
    { name: "conflict", type: "json", required: false },
    { name: "receivedAt", type: "date", required: true },
  ],
  obol_sync_stations: [
    { name: "stationId", type: "text", required: true },
    { name: "deviceLabel", type: "text", required: false },
    { name: "platform", type: "select", required: false, values: ["ios", "macos", "windows"] },
    { name: "firstSeenAt", type: "date", required: false },
    { name: "lastSeenAt", type: "date", required: false },
    { name: "lastCursor", type: "number", required: false, onlyInt: true, min: 0 },
  ],
  obol_station_outbox: [
    { name: "opId", type: "text", required: true },
    { name: "protocolVersion", type: "number", required: true, onlyInt: true, min: 1 },
    { name: "type", type: "text", required: true },
    { name: "entityType", type: "text", required: true },
    { name: "entityId", type: "text", required: true },
    { name: "payload", type: "json", required: false },
    // Complete-envelope hash (D016 D2 rule 9).
    { name: "payloadHash", type: "text", required: true },
    { name: "baseRevisions", type: "json", required: false },
    { name: "dependsOn", type: "json", required: false },
    { name: "effectiveAt", type: "date", required: true },
    { name: "clientCreatedAt", type: "date", required: true },
    { name: "beforeSnapshots", type: "json", required: false },
    {
      name: "status",
      type: "select",
      required: true,
      values: ["queued", "in_flight", "accepted", "conflict", "rejected"],
    },
    { name: "attempts", type: "number", required: false, onlyInt: true, min: 0 },
    { name: "lastError", type: "text", required: false },
    { name: "createdAt", type: "date", required: true },
    { name: "updatedAt", type: "date", required: true },
  ],
  // Singleton by convention; every field is optional until a station binds.
  obol_station_state: [
    { name: "serverUrl", type: "text", required: false },
    { name: "serverInstanceId", type: "text", required: false },
    { name: "ownerFingerprint", type: "text", required: false },
    { name: "stationId", type: "text", required: false },
    { name: "cursor", type: "number", required: false, onlyInt: true, min: 0 },
    { name: "lastChainHash", type: "text", required: false },
    { name: "dataEpoch", type: "number", required: false, onlyInt: true, min: 0 },
    { name: "protocolVersion", type: "number", required: false, onlyInt: true, min: 1 },
    { name: "mode", type: "select", required: false, values: ["standalone", "station"] },
  ],
  obol_station_conflicts: [
    { name: "opId", type: "text", required: true },
    { name: "conflict", type: "json", required: false },
    {
      name: "resolution",
      type: "select",
      required: true,
      values: ["pending", "server", "retry", "discarded"],
    },
    { name: "createdAt", type: "date", required: true },
    { name: "updatedAt", type: "date", required: true },
  ],
  obol_station_versions: [
    { name: "entityType", type: "text", required: true },
    { name: "entityId", type: "text", required: true },
    { name: "serverRevision", type: "number", required: false, onlyInt: true, min: 0 },
    { name: "localRevision", type: "number", required: false, onlyInt: true, min: 0 },
    { name: "deleted", type: "bool", required: false },
  ],
};

function buildSyncField(spec) {
  if (spec.type === "text") {
    return new TextField({ name: spec.name, required: spec.required });
  }
  if (spec.type === "number") {
    const field = new NumberField({
      name: spec.name,
      required: spec.required,
      onlyInt: spec.onlyInt === true,
    });
    if (spec.min !== undefined) {
      field.min = spec.min;
    }
    return field;
  }
  if (spec.type === "bool") {
    return new BoolField({ name: spec.name, required: spec.required });
  }
  if (spec.type === "date") {
    return new DateField({ name: spec.name, required: spec.required });
  }
  if (spec.type === "json") {
    return new JSONField({ name: spec.name, required: spec.required });
  }
  if (spec.type === "select") {
    return new SelectField({
      name: spec.name,
      required: spec.required,
      maxSelect: 1,
      values: spec.values,
    });
  }
  throw new Error("Unknown sync field type: " + spec.type);
}

migrate((app) => {
  for (const collectionName of Object.keys(SYNC_FIELD_SPECS)) {
    const collection = app.findCollectionByNameOrId(collectionName);
    const present = collection.fields.fieldNames();
    let changed = false;

    for (const spec of SYNC_FIELD_SPECS[collectionName]) {
      if (present.indexOf(spec.name) >= 0) {
        const existing = collection.fields.getByName(spec.name);
        const existingType =
          typeof existing.type === "function" ? existing.type() : existing.type;
        if (existingType !== spec.type) {
          throw new Error(
            "fields.add: " + collectionName + "." + spec.name +
              " exists with incompatible type " + existingType +
              " (expected " + spec.type + ")"
          );
        }
        continue; // Idempotent: keep the existing compatible field.
      }

      collection.fields.add(buildSyncField(spec));
      changed = true;
    }

    if (changed) {
      app.save(collection);
    }
  }
}, (app) => {
  for (const collectionName of Object.keys(SYNC_FIELD_SPECS)) {
    const collection = app.findCollectionByNameOrId(collectionName);
    const present = collection.fields.fieldNames();
    let changed = false;

    for (const spec of SYNC_FIELD_SPECS[collectionName]) {
      if (present.indexOf(spec.name) < 0) {
        continue;
      }
      collection.fields.removeByName(spec.name);
      changed = true;
    }

    if (changed) {
      app.save(collection);
    }
  }
});
