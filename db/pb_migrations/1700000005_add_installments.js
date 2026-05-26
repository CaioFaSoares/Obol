migrate((app) => {
  const collection = app.findCollectionByNameOrId("recurrences");

  collection.fields.add(new NumberField({
    name: "total_installments",
    required: false
  }));

  app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("recurrences");
  collection.fields.removeByName("total_installments");
  app.save(collection);
});
