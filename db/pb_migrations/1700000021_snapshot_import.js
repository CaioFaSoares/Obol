// D016 D7 / canon §12.4: durable settled-snapshot import receipts and the
// desktop station replica/checkpoint fields.
//
// This migration owns exactly two things:
//   1. A private `obol_sync_snapshot_imports` collection holding the seven
//      receipt fields of `POST /api/sync/import`: `importId` (UUIDv7 in its
//      own namespace), `stationId` (UUIDv7), the complete six-field
//      `payloadHash` (at most 50 characters: `sha256:` plus 43 unpadded
//      base64url characters), `serverInstanceId` (UUIDv7), `dataEpoch`
//      (positive integer), the stored original `result` JSON, and
//      `createdAt`. The collection id is PocketBase's own system id.
//   2. Four optional fields on station collections created by migrations
//      1700000018-1700000020: `obol_station_state.pendingImport` (JSON, at
//      most 12 MiB), `obol_station_versions.baseRecord` (JSON, at most
//      1 MiB), `obol_station_versions.serverDeleted` (bool), and
//      `obol_station_outbox.acknowledgement` (JSON, at most 2 MiB).
//
// `pendingImport` is the coherent pre-network import checkpoint. `baseRecord`
// is the full latest remote base row and `serverDeleted` its server-side
// tombstone; both stay separate from the optimistic-local `deleted` flag and
// from the separate `serverRevision`/`localRevision` counters. A remote base
// must not overwrite an unaccepted local write, and `beforeSnapshots` cannot
// retain a newer remote base, so `baseRecord` is the reconstruction input
// after a crash. `acknowledgement` stores only the minimal accepted causal
// receipt (op id, commit id, seq bound, per-entity versions): never whole
// entity records and never credentials.
//
// Public rules stay null on every touched collection; only the BFF superuser
// reads or writes PocketBase. The receipt row is created in the same
// PocketBase transaction as the imported finance rows, their revision-1 rows,
// and the journal commit. A retry with the same import id and frozen content
// replays the stored result; different content under the same id is rejected;
// a receipt is cleared when an administrative reset increments `dataEpoch`.
// No finance field is added or changed here.
//
// PocketBase 0.40.6 does not persist fields declared on a Collection
// constructor in this JSVM flow, so the shell is created first and every
// typed field is added with `fields.add` before the indexes are appended,
// mirroring migrations 1700000018-1700000020. Up is idempotent: an existing
// collection is kept, an existing field of the expected type is kept, and an
// existing index is kept. A same-named field of another type aborts instead
// of leaving a malformed schema. Errors from `save` or `delete` are never
// caught or swallowed. Down removes only this migration's collection and the
// four optional fields it adds; no finance, owner, or session row is touched.
const SNAPSHOT_IMPORT_COLLECTION = "obol_sync_snapshot_imports";

const SNAPSHOT_IMPORT_FIELD_SPECS = [
  // UUIDv7 values travel as canonical text; PocketBase text has no UUID
  // validator, and the BFF validates the UUID namespace before writing.
  { name: "importId", type: "text", required: true },
  { name: "stationId", type: "text", required: true },
  // `sha256:` + 43 unpadded base64url characters = 50 characters.
  { name: "payloadHash", type: "text", required: true, max: 50 },
  { name: "serverInstanceId", type: "text", required: true },
  // Epoch 0 is never a deployed epoch; it starts at 1 and only increases.
  { name: "dataEpoch", type: "number", required: true, onlyInt: true, min: 1 },
  // The committed import always stores a non-empty original response object,
  // so `required` is correct here. Optional JSON fields elsewhere stay
  // optional because `{}`, `[]`, `""`, and `null` are valid values there.
  { name: "result", type: "json", required: true },
  { name: "createdAt", type: "date", required: true },
];

const STATION_FIELD_ADDITIONS = {
  // Pre-network checkpoint for the one frozen import. Never a token or secret.
  obol_station_state: [
    {
      name: "pendingImport",
      type: "json",
      required: false,
      maxSize: 12 * 1024 * 1024,
    },
  ],
  // Remote base layer, separate from the optimistic-local `deleted` flag.
  obol_station_versions: [
    {
      name: "baseRecord",
      type: "json",
      required: false,
      maxSize: 1024 * 1024,
    },
    { name: "serverDeleted", type: "bool", required: false },
  ],
  // Minimal accepted causal receipt; never full entities or secrets.
  obol_station_outbox: [
    {
      name: "acknowledgement",
      type: "json",
      required: false,
      maxSize: 2 * 1024 * 1024,
    },
  ],
};

const SNAPSHOT_IMPORT_INDEXES = [
  "CREATE UNIQUE INDEX idx_obol_sync_snapshot_imports_importId ON " +
    SNAPSHOT_IMPORT_COLLECTION +
    " (importId)",
  "CREATE INDEX idx_obol_sync_snapshot_imports_stationId ON " +
    SNAPSHOT_IMPORT_COLLECTION +
    " (stationId)",
];

function buildField(spec) {
  if (spec.type === "text") {
    const field = new TextField({ name: spec.name, required: spec.required });
    if (spec.max !== undefined) {
      field.max = spec.max;
    }
    return field;
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
    const field = new JSONField({ name: spec.name, required: spec.required });
    if (spec.maxSize !== undefined) {
      field.maxSize = spec.maxSize;
    }
    return field;
  }
  throw new Error("Unknown snapshot-import field type: " + spec.type);
}

function addFields(app, collectionName, specs) {
  const collection = app.findCollectionByNameOrId(collectionName);
  const present = collection.fields.fieldNames();
  let changed = false;

  for (const spec of specs) {
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

    collection.fields.add(buildField(spec));
    changed = true;
  }

  if (changed) {
    app.save(collection);
  }
}

function removeFields(app, collectionName, specs) {
  const collection = app.findCollectionByNameOrId(collectionName);
  const present = collection.fields.fieldNames();
  let changed = false;

  for (const spec of specs) {
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

function indexName(statement) {
  // Every statement above has the form "CREATE [UNIQUE] INDEX name ON ...".
  const match = statement.match(/^CREATE (?:UNIQUE )?INDEX ([A-Za-z0-9_]+) ON /);
  if (!match) {
    throw new Error("Unrecognized snapshot-import index statement: " + statement);
  }
  return match[1];
}

function addIndexes(app, statements) {
  const collection = app.findCollectionByNameOrId(SNAPSHOT_IMPORT_COLLECTION);
  let changed = false;

  for (const statement of statements) {
    const name = indexName(statement);
    if (collection.indexes.some((index) => index.indexOf(name) >= 0)) {
      continue; // Idempotent: index already present.
    }
    collection.indexes.push(statement);
    changed = true;
  }

  if (changed) {
    app.save(collection);
  }
}

function collectionCatalog(app) {
  // Read the catalog once instead of catching lookup errors: a real database
  // failure must abort the migration rather than look like "absent".
  const catalog = {};
  for (const collection of app.findAllCollections()) {
    if (collection) {
      catalog[collection.name] = collection;
    }
  }
  return catalog;
}

migrate((app) => {
  const catalog = collectionCatalog(app);

  if (!catalog[SNAPSHOT_IMPORT_COLLECTION]) {
    app.save(
      new Collection({
        name: SNAPSHOT_IMPORT_COLLECTION,
        type: "base",
        system: false,
        listRule: null,
        viewRule: null,
        createRule: null,
        updateRule: null,
        deleteRule: null,
      })
    );
  }

  // Fields before indexes: an index over a missing column aborts with
  // "no such column".
  addFields(app, SNAPSHOT_IMPORT_COLLECTION, SNAPSHOT_IMPORT_FIELD_SPECS);
  for (const collectionName of Object.keys(STATION_FIELD_ADDITIONS)) {
    addFields(app, collectionName, STATION_FIELD_ADDITIONS[collectionName]);
  }
  addIndexes(app, SNAPSHOT_IMPORT_INDEXES);
}, (app) => {
  const catalog = collectionCatalog(app);

  // Remove only the optional fields this migration adds to preexisting
  // station collections. A collection absent from the catalog is skipped.
  for (const collectionName of Object.keys(STATION_FIELD_ADDITIONS)) {
    if (!catalog[collectionName]) {
      continue;
    }
    removeFields(app, collectionName, STATION_FIELD_ADDITIONS[collectionName]);
  }

  // The receipt collection and its indexes belong entirely to this
  // migration; deleting the collection removes both.
  if (catalog[SNAPSHOT_IMPORT_COLLECTION]) {
    app.delete(catalog[SNAPSHOT_IMPORT_COLLECTION]);
  }
});
