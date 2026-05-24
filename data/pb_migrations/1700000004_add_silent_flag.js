migrate((app) => {
  const collection = app.findCollectionByNameOrId("transactions");
  
  collection.fields.add(new BoolField({
    name: "is_silent",
    required: false
  }));

  app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("transactions");
  collection.fields.removeByName("is_silent");
  app.save(collection);
});
