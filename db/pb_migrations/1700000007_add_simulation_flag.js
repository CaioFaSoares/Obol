migrate((app) => {
  const collection = app.findCollectionByNameOrId("transactions");

  collection.fields.add(new BoolField({
    name: "is_simulated",
    required: false
  }));

  app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("transactions");
  collection.fields.removeByName("is_simulated");
  app.save(collection);
});
