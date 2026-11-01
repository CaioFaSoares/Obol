// Finance audit dates (`created`/`updated`) as APPLICABLE storage.
//
// The native FinancialSnapshot encodes optional `created`/`updated` on every
// record and the server snapshot validator accepts them on seed/import, but a
// collection created by the 1700000000 schema only gets the `id` system field
// from PocketBase 0.40.6 (`Collection.initDefaultFields` adds nothing else).
// The record create then drops unknown keys silently, so an import answered
// 200 while losing the client's audit dates.
//
// `autodate` fields are not a fix: PocketBase's `AutodateField` setter is a
// no-op (`FindSetter` returns `noopSetter`), so no HTTP create/update can
// write a client value. That is also why an upgraded deployment whose finance
// collections still carry autodate `created`/`updated` must be normalized: the
// field becomes a plain `date` field that keeps the SAME field id, so
// `SyncRecordTableSchema` matches the columns by id and preserves the stored
// values (autodate and date share the same TEXT column type).
//
// Ordinary pushes never send these fields: the per-operation payload
// validators (SyncWireValidators) reject unknown payload keys, so only the
// seed/import snapshot path and the pull-record echo can carry them.
//
// Up is idempotent: an existing `date` field is kept as is, an `autodate`
// field is converted in place, and a missing field is added. A same-named
// field of any other type aborts instead of leaving a malformed schema. Errors
// from `save` are never caught or swallowed. Down restores the previous
// autodate shape with the same field id; audit values are never dropped.
const FINANCE_COLLECTIONS = [
  "accounts",
  "cards",
  "categories",
  "invoices",
  "projects",
  "recurrences",
  "transactions",
];

// `created` is stamped on create only; `updated` on create and update.
const AUDIT_FIELDS = [
  { name: "created", onCreate: true, onUpdate: false },
  { name: "updated", onCreate: true, onUpdate: true },
];

function fieldTypeOf(field) {
  return typeof field.type === "function" ? field.type() : field.type;
}

function findCollection(app, name) {
  for (const collection of app.findAllCollections()) {
    if (collection && collection.name === name) {
      return collection;
    }
  }
  return null;
}

migrate((app) => {
  for (const name of FINANCE_COLLECTIONS) {
    const collection = findCollection(app, name);
    if (!collection) {
      continue; // A deployment that does not own finance data keeps no row.
    }

    let changed = false;
    for (const spec of AUDIT_FIELDS) {
      const existing = collection.fields.getByName(spec.name);
      if (existing) {
        const existingType = fieldTypeOf(existing);
        if (existingType === "date") {
          continue; // Idempotent: already applicable storage.
        }
        if (existingType !== "autodate") {
          throw new Error(
            name + "." + spec.name + " exists with incompatible type " +
              existingType + " (expected date or autodate); refusing to continue"
          );
        }
        // Same id: the record table sync keeps the column and its values.
        const fieldId = existing.id;
        collection.fields.removeById(fieldId);
        collection.fields.add(
          new DateField({ id: fieldId, name: spec.name, required: false })
        );
        changed = true;
        continue;
      }

      collection.fields.add(
        new DateField({ name: spec.name, required: false })
      );
      changed = true;
    }

    if (changed) {
      app.save(collection);
    }
  }
}, (app) => {
  for (const name of FINANCE_COLLECTIONS) {
    const collection = findCollection(app, name);
    if (!collection) {
      continue;
    }

    let changed = false;
    for (const spec of AUDIT_FIELDS) {
      const existing = collection.fields.getByName(spec.name);
      if (!existing) {
        continue;
      }
      const existingType = fieldTypeOf(existing);
      if (existingType === "autodate") {
        continue; // Already the pre-migration shape.
      }
      if (existingType !== "date") {
        throw new Error(
          name + "." + spec.name + " is now " + existingType +
            " (expected date); refusing to convert a field this migration did not own"
        );
      }
      const fieldId = existing.id;
      collection.fields.removeById(fieldId);
      collection.fields.add(
        new AutodateField({
          id: fieldId,
          name: spec.name,
          onCreate: spec.onCreate,
          onUpdate: spec.onUpdate,
        })
      );
      changed = true;
    }

    if (changed) {
      app.save(collection);
    }
  }
});
