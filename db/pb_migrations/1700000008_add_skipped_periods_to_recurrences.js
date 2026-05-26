/// <reference path="../pb_data/types.d.ts" />
migrate((db) => {
  const collection = new Collection({
    "id": "recurrences_collection",
  });
  
  // Just update the existing collection
  const dao = new Dao(db);
  const existing = dao.findCollectionByNameOrId("recurrences");
  
  existing.schema.addField(new SchemaField({
    "system": false,
    "id": "skipped_periods",
    "name": "skipped_periods",
    "type": "json",
    "required": false,
    "presentable": false,
    "unique": false,
    "options": {}
  }));

  return dao.saveCollection(existing);
}, (db) => {
  const dao = new Dao(db);
  const collection = dao.findCollectionByNameOrId("recurrences");
  collection.schema.removeField("skipped_periods");
  return dao.saveCollection(collection);
})
