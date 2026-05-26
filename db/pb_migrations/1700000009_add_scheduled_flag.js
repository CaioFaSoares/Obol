/// <reference path="../pb_data/types.d.ts" />

migrate((app) => {
  const collection = app.findCollectionByNameOrId("transactions");

  collection.fields.addAt(collection.fields.length, new Field({
    system: false,
    name: "is_scheduled",
    type: "bool",
    required: false,
    options: {}
  }));

  app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("transactions");
  collection.fields.removeByName("is_scheduled");
  app.save(collection);
});
