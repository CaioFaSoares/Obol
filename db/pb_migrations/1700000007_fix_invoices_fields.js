migrate((app) => {
  const collection = app.findCollectionByNameOrId("invoices");

  collection.listRule = "";
  collection.viewRule = "";
  collection.createRule = "";
  collection.updateRule = "";
  collection.deleteRule = "";

  collection.fields.add(new RelationField({
    name: "card_id",
    required: true,
    collectionId: app.findCollectionByNameOrId("cards").id,
    cascadeDelete: false,
    maxSelect: 1,
  }));
  collection.fields.add(new TextField({
    name: "period",
    required: true,
  }));
  collection.fields.add(new DateField({
    name: "due_date",
    required: true,
  }));
  collection.fields.add(new SelectField({
    name: "status",
    required: true,
    maxSelect: 1,
    values: ["OPEN", "CLOSED", "PAID"],
  }));
  collection.fields.add(new NumberField({
    name: "total_amount",
    required: true,
  }));
  collection.fields.add(new NumberField({
    name: "paid_amount",
    required: false,
  }));

  app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("invoices");
  collection.listRule = null;
  collection.viewRule = null;
  collection.createRule = null;
  collection.updateRule = null;
  collection.deleteRule = null;
  
  collection.fields.removeByName("card_id");
  collection.fields.removeByName("period");
  collection.fields.removeByName("due_date");
  collection.fields.removeByName("status");
  collection.fields.removeByName("total_amount");
  collection.fields.removeByName("paid_amount");
  app.save(collection);
});
