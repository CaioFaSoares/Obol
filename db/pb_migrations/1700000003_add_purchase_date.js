migrate((app) => {
  const collection = app.findCollectionByNameOrId("transactions");
  
  // Add purchase_date field
  collection.fields.add(new DateField({
    name: "purchase_date",
    required: false
  }));

  app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("transactions");
  collection.fields.removeByName("purchase_date");
  app.save(collection);
});
