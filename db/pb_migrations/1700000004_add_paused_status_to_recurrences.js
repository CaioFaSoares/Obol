migrate((app) => {
  const collection = app.findCollectionByNameOrId("recurrences");
  const statusField = collection.fields.getByName("status");
  statusField.values = ["active", "paused", "ended"];
  app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("recurrences");
  const statusField = collection.fields.getByName("status");
  statusField.values = ["active", "ended"];
  app.save(collection);
});
