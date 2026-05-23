migrate((app) => {
  const collection = app.findCollectionByNameOrId("accounts");
  const field = collection.fields.getByName("initial_balance");
  field.required = false;
  app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("accounts");
  const field = collection.fields.getByName("initial_balance");
  field.required = true;
  app.save(collection);
});
