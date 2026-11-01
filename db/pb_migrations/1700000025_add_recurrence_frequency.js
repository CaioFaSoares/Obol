// `recurrences` gains an optional cadence (D019): a select `frequency`
// (`monthly` | `weekly`, blank reads as monthly) and a number `weekday` (ISO 1-7,
// required for weekly rows and stored as the blank `0` for monthly rows, the
// same convention `total_installments` uses).
//
// Both fields are optional and additive, so a deployment that never creates a
// weekly recurrence stores exactly the 0.4.0 row plus two empty columns.
//
// Up is idempotent: a compatible existing field is kept as is, and a
// same-named field of another type aborts instead of leaving a malformed
// schema. Errors from `save` are never caught or swallowed. Down removes
// exactly these two fields and nothing else.
const COLLECTION_NAME = "recurrences";
const FREQUENCY_FIELD = "frequency";
const WEEKDAY_FIELD = "weekday";
const FREQUENCIES = ["monthly", "weekly"];

function fieldTypeOf(field) {
  return typeof field.type === "function" ? field.type() : field.type;
}

migrate((app) => {
  const collection = app.findCollectionByNameOrId(COLLECTION_NAME);
  const present = collection.fields.fieldNames();
  let changed = false;

  if (present.indexOf(FREQUENCY_FIELD) >= 0) {
    const existing = collection.fields.getByName(FREQUENCY_FIELD);
    const existingType = fieldTypeOf(existing);
    if (existingType !== "select") {
      throw new Error(
        "recurrences." + FREQUENCY_FIELD + " exists with incompatible type " +
          existingType + " (expected select); refusing to continue"
      );
    }
    const existingValues = Array.isArray(existing.values) ? existing.values.slice().sort() : [];
    const expectedValues = FREQUENCIES.slice().sort();
    // A PocketBase single select carries `maxSelect: 1`; an unset value is the
    // single-select default.
    const existingMaxSelect = existing.maxSelect === undefined ? 1 : existing.maxSelect;
    if (existingValues.join(",") !== expectedValues.join(",") || existingMaxSelect !== 1) {
      throw new Error(
        "recurrences." + FREQUENCY_FIELD + " exists with incompatible values " +
          JSON.stringify(existing.values) + " (expected " + JSON.stringify(FREQUENCIES) +
          " with maxSelect 1); refusing to continue"
      );
    }
    // Idempotent: the exact select already exists.
  } else {
    collection.fields.add(
      new SelectField({
        name: FREQUENCY_FIELD,
        required: false,
        maxSelect: 1,
        values: FREQUENCIES,
      })
    );
    changed = true;
  }

  if (present.indexOf(WEEKDAY_FIELD) >= 0) {
    const existing = collection.fields.getByName(WEEKDAY_FIELD);
    const existingType = fieldTypeOf(existing);
    if (existingType !== "number") {
      throw new Error(
        "recurrences." + WEEKDAY_FIELD + " exists with incompatible type " +
          existingType + " (expected number); refusing to continue"
      );
    }
    // Idempotent: the exact number field already exists.
  } else {
    collection.fields.add(
      new NumberField({
        name: WEEKDAY_FIELD,
        required: false,
      })
    );
    changed = true;
  }

  if (changed) {
    app.save(collection);
  }
}, (app) => {
  let collection;
  try {
    collection = app.findCollectionByNameOrId(COLLECTION_NAME);
  } catch (_) {
    return; // collection absent, nothing to remove
  }

  const present = collection.fields.fieldNames();
  let changed = false;

  if (present.indexOf(FREQUENCY_FIELD) >= 0) {
    const existing = collection.fields.getByName(FREQUENCY_FIELD);
    const existingType = fieldTypeOf(existing);
    if (existingType !== "select") {
      throw new Error(
        "recurrences." + FREQUENCY_FIELD + " is now " + existingType +
          " (expected select); refusing to remove a field this migration did not add"
      );
    }
    collection.fields.removeByName(FREQUENCY_FIELD);
    changed = true;
  }

  if (present.indexOf(WEEKDAY_FIELD) >= 0) {
    const existing = collection.fields.getByName(WEEKDAY_FIELD);
    const existingType = fieldTypeOf(existing);
    if (existingType !== "number") {
      throw new Error(
        "recurrences." + WEEKDAY_FIELD + " is now " + existingType +
          " (expected number); refusing to remove a field this migration did not add"
      );
    }
    collection.fields.removeByName(WEEKDAY_FIELD);
    changed = true;
  }

  if (changed) {
    app.save(collection);
  }
});
