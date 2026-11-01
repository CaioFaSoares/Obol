// `recurrences` never had a `category_id` relation, so a validated snapshot
// row that declares one is silently accepted by PocketBase's record create
// (unknown keys are ignored) and the field is lost without an error. The
// snapshot validators (server/src/infrastructure/validators/
// SyncSnapshotValidators.ts) and the native FinancialSnapshot both carry the
// optional field, and `transactions.category_id` already exists, so the
// recurrence simply gains the same optional single relation.
//
// Up is idempotent: an existing relation field bound to `categories` is kept
// as is, and a same-named field of another type aborts instead of leaving a
// malformed schema. Errors from `save` are never caught or swallowed. Down
// removes exactly this field and nothing else. BFF snapshots are additionally
// cross-checked against the live collection schema before a seed/import
// writes (PocketBaseSnapshotGateway), so a deployment that missed this
// migration rejects the row instead of dropping the field.
const COLLECTION_NAME = "recurrences";
const FIELD_NAME = "category_id";
const TARGET_COLLECTION_NAME = "categories";

function fieldTypeOf(field) {
  return typeof field.type === "function" ? field.type() : field.type;
}

migrate((app) => {
  const collection = app.findCollectionByNameOrId(COLLECTION_NAME);
  const target = app.findCollectionByNameOrId(TARGET_COLLECTION_NAME);
  const present = collection.fields.fieldNames();

  if (present.indexOf(FIELD_NAME) >= 0) {
    const existing = collection.fields.getByName(FIELD_NAME);
    const existingType = fieldTypeOf(existing);
    if (existingType !== "relation") {
      throw new Error(
        "recurrences." + FIELD_NAME + " exists with incompatible type " +
          existingType + " (expected relation); refusing to continue"
      );
    }
    if (existing.collectionId !== target.id) {
      throw new Error(
        "recurrences." + FIELD_NAME + " is already bound to collection " +
          String(existing.collectionId) + " instead of " + TARGET_COLLECTION_NAME +
          "; refusing to rebind it"
      );
    }
    return; // Idempotent: the exact relation already exists.
  }

  collection.fields.add(
    new RelationField({
      name: FIELD_NAME,
      required: false,
      collectionId: target.id,
      cascadeDelete: false,
      maxSelect: 1,
    })
  );
  app.save(collection);
}, (app) => {
  let collection;
  try {
    collection = app.findCollectionByNameOrId(COLLECTION_NAME);
  } catch (_) {
    return; // collection absent, nothing to remove
  }

  const present = collection.fields.fieldNames();
  if (present.indexOf(FIELD_NAME) < 0) {
    return; // field absent, nothing to remove
  }

  const existing = collection.fields.getByName(FIELD_NAME);
  const existingType = fieldTypeOf(existing);
  if (existingType !== "relation") {
    throw new Error(
      "recurrences." + FIELD_NAME + " is now " + existingType +
        " (expected relation); refusing to remove a field this migration did not add"
    );
  }

  collection.fields.removeByName(FIELD_NAME);
  app.save(collection);
});
