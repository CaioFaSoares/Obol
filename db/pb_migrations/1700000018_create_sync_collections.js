// D016 / canon §12.4 sync persistence metadata. Creates the nine sync and
// station collections as bare base collections. Under the pinned PocketBase
// 0.40.6 runtime, fields declared on a Collection constructor are not
// persisted, and an index over them then aborts the migration ("no such
// column"), so this migration only creates the collection shells; migration
// 1700000019 adds the typed fields with `fields.add` and 1700000020 adds the
// indexes, mirroring the 0014-0017 repair pattern.
//
// All rules stay null: the collections are read and written only by the BFF
// superuser. `obol_station_*` tables are local-only for a desktop station but
// are created in every deployment (empty on a central server).
//
// Up is idempotent: an existing collection is left untouched. Down deletes
// only the collections this migration owns; no finance, owner, or session
// collection is referenced or modified.
const SYNC_COLLECTION_NAMES = [
  "obol_sync_meta",
  "obol_sync_entity_versions",
  "obol_sync_changes",
  "obol_sync_operations",
  "obol_sync_stations",
  "obol_station_outbox",
  "obol_station_state",
  "obol_station_conflicts",
  "obol_station_versions",
];

migrate((app) => {
  // Read the catalog once instead of catching lookup errors: a real database
  // failure must abort the migration rather than look like "absent".
  const existing = {};
  for (const collection of app.findAllCollections()) {
    if (collection) {
      existing[collection.name] = collection;
    }
  }

  for (const name of SYNC_COLLECTION_NAMES) {
    if (existing[name]) {
      continue; // Idempotent: already created by an earlier run.
    }

    const collection = new Collection({
      name: name,
      type: "base",
      system: false,
      listRule: null,
      viewRule: null,
      createRule: null,
      updateRule: null,
      deleteRule: null,
    });

    app.save(collection);
  }
}, (app) => {
  const existing = {};
  for (const collection of app.findAllCollections()) {
    if (collection) {
      existing[collection.name] = collection;
    }
  }

  for (const name of SYNC_COLLECTION_NAMES) {
    if (existing[name]) {
      app.delete(existing[name]);
    }
  }
});
