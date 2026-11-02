// PocketBase treats the number 0 as blank for a `required` numeric field, so an
// `invoices` row with `total_amount: 0` is rejected with
// `{"total_amount":{"code":"validation_required","message":"Cannot be blank."}}`.
// That row is legitimate domain state: `docs/canon.md` §5 keys invoices by
// `(card_id, period)`, so a card period with no purchases still owns an invoice
// with zero debt and zero gross spent, and the invoice timeline reports it as
// `total_spent: "0.00"`. Relaxing `required` removes only PocketBase's blank
// check; use cases keep writing a number. See ADR
// docs/decisions/D018-zero-total-invoices.md and the earlier relaxation in
// 1700000003_allow_zero_balance.js.
//
// Only `required` changes. `min`, `max`, `onlyInt`, the default value, every
// other field and every collection rule stay exactly as 1700000007 left them.
migrate((app) => {
  let collection;
  try {
    collection = app.findCollectionByNameOrId("invoices");
  } catch (_) {
    return; // collection absent, nothing to relax
  }

  let field = null;
  try {
    field = collection.fields.getByName("total_amount");
  } catch (_) {
    field = null; // absent, nothing to relax
  }
  if (!field) {
    return;
  }

  const fieldType = typeof field.type === "function" ? field.type() : field.type;
  if (fieldType !== "number") {
    throw new Error(
      "invoices.total_amount exists with incompatible type " + fieldType +
        " (expected number); refusing to relax it"
    );
  }

  if (field.required === false) {
    return; // already optional
  }

  field.required = false;
  app.save(collection);
}, (app) => {
  let collection;
  try {
    collection = app.findCollectionByNameOrId("invoices");
  } catch (_) {
    return; // collection absent, nothing to restore
  }

  let field = null;
  try {
    field = collection.fields.getByName("total_amount");
  } catch (_) {
    field = null; // absent, nothing to restore
  }
  if (!field) {
    return;
  }

  const fieldType = typeof field.type === "function" ? field.type() : field.type;
  if (fieldType !== "number") {
    throw new Error(
      "invoices.total_amount exists with incompatible type " + fieldType +
        " (expected number); refusing to restore it"
    );
  }

  if (field.required === true) {
    return; // already required
  }

  // Restoring the blank check would make existing zero-total invoices
  // unsaveable and fail their next update, so refuse instead of destroying or
  // silently hiding them.
  const violating = app.findRecordsByFilter(
    "invoices",
    "total_amount = null || total_amount = 0",
    "",
    0,
    0
  ).length;

  if (violating > 0) {
    throw new Error(
      "invoices.total_amount cannot be required again: " + violating +
        " invoice record(s) have a null or zero total_amount " +
        "(see docs/decisions/D018-zero-total-invoices.md)"
    );
  }

  field.required = true;
  app.save(collection);
});
