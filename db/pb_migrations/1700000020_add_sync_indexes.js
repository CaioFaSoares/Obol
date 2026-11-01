// D016 / canon §12.4 indexes for the sync and station collections. Fields
// exist by migration 1700000019; an index over a missing field would abort
// with "no such column", so this migration runs last.
//
// Up is idempotent: an index whose name is already present is left alone and
// the collection is only saved when something was added. Down removes exactly
// the indexes this migration owns. Lookup failures and save errors are never
// swallowed.
const SYNC_INDEXES = {
  obol_sync_meta: [], // singleton by convention; no index
  obol_sync_entity_versions: [
    "CREATE UNIQUE INDEX idx_obol_sync_entity_versions_entity ON obol_sync_entity_versions (entityType, entityId)",
    "CREATE INDEX idx_obol_sync_entity_versions_lastSeq ON obol_sync_entity_versions (lastSeq)",
  ],
  obol_sync_changes: [
    "CREATE UNIQUE INDEX idx_obol_sync_changes_seq ON obol_sync_changes (seq)",
    "CREATE UNIQUE INDEX idx_obol_sync_changes_chainHash ON obol_sync_changes (chainHash)",
    "CREATE INDEX idx_obol_sync_changes_eventKey ON obol_sync_changes (eventKey)",
    "CREATE INDEX idx_obol_sync_changes_createdAt ON obol_sync_changes (createdAt)",
    "CREATE UNIQUE INDEX idx_obol_sync_changes_commit ON obol_sync_changes (commitId, commitIndex)",
  ],
  obol_sync_operations: [
    "CREATE UNIQUE INDEX idx_obol_sync_operations_opId ON obol_sync_operations (opId)",
    "CREATE INDEX idx_obol_sync_operations_station_received ON obol_sync_operations (stationId, receivedAt)",
  ],
  obol_sync_stations: [
    "CREATE UNIQUE INDEX idx_obol_sync_stations_stationId ON obol_sync_stations (stationId)",
  ],
  obol_station_outbox: [
    "CREATE UNIQUE INDEX idx_obol_station_outbox_opId ON obol_station_outbox (opId)",
    "CREATE INDEX idx_obol_station_outbox_status_created ON obol_station_outbox (status, createdAt)",
  ],
  obol_station_state: [], // singleton by convention; no index
  obol_station_conflicts: [
    "CREATE UNIQUE INDEX idx_obol_station_conflicts_opId ON obol_station_conflicts (opId)",
  ],
  obol_station_versions: [
    "CREATE UNIQUE INDEX idx_obol_station_versions_entity ON obol_station_versions (entityType, entityId)",
  ],
};

function syncIndexName(statement) {
  // Every statement in SYNC_INDEXES has the form "CREATE [UNIQUE] INDEX name ON ...".
  const match = statement.match(/^CREATE (?:UNIQUE )?INDEX ([A-Za-z0-9_]+) ON /);
  if (!match) {
    throw new Error("Unrecognized sync index statement: " + statement);
  }
  return match[1];
}

migrate((app) => {
  for (const collectionName of Object.keys(SYNC_INDEXES)) {
    const statements = SYNC_INDEXES[collectionName];
    if (statements.length === 0) {
      continue;
    }

    const collection = app.findCollectionByNameOrId(collectionName);
    let changed = false;

    for (const statement of statements) {
      const indexName = syncIndexName(statement);
      const present = collection.indexes.some((index) => index.indexOf(indexName) >= 0);
      if (present) {
        continue; // Idempotent: index already exists.
      }
      collection.indexes.push(statement);
      changed = true;
    }

    if (changed) {
      app.save(collection);
    }
  }
}, (app) => {
  const existing = {};
  for (const collection of app.findAllCollections()) {
    if (collection) {
      existing[collection.name] = collection;
    }
  }

  for (const collectionName of Object.keys(SYNC_INDEXES)) {
    const statements = SYNC_INDEXES[collectionName];
    if (statements.length === 0) {
      continue;
    }

    const collection = existing[collectionName];
    if (!collection) {
      continue; // Nothing to roll back if the collection is already gone.
    }

    // Re-read a fresh model before editing: findAllCollections is used only
    // for the presence check, never as the model that gets saved.
    const fresh = app.findCollectionByNameOrId(collectionName);
    const indexNames = statements.map(syncIndexName);
    const kept = fresh.indexes.filter(
      (index) => !indexNames.some((name) => index.indexOf(name) >= 0)
    );

    if (kept.length !== fresh.indexes.length) {
      fresh.indexes = kept;
      app.save(fresh);
    }
  }
});
