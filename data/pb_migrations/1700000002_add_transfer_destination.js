migrate((app) => {
  const collection = app.findCollectionByNameOrId("transactions");

  // Adiciona o campo que guarda para onde o dinheiro foi
  collection.fields.add(new RelationField({
    name: "destination_account_id",
    required: false,
    collectionId: app.findCollectionByNameOrId("accounts").id,
    maxSelect: 1
  }));

  app.save(collection);
}, (app) => {
  // Rollback
  const collection = app.findCollectionByNameOrId("transactions");
  collection.fields.removeByName("destination_account_id");
  app.save(collection);
});
