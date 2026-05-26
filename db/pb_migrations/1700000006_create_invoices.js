migrate((app) => {
  const collection = new Collection({
    id: "invoices_collection", // Custom ID or let PB generate
    name: "invoices",
    type: "base",
    system: false,
    fields: [
      new RelationField({
        name: "card_id",
        required: true,
        collectionId: app.findCollectionByNameOrId("cards").id,
        cascadeDelete: false,
        maxSelect: 1,
      }),
      new TextField({
        name: "period",
        required: true,
      }),
      new DateField({
        name: "due_date",
        required: true,
      }),
      new SelectField({
        name: "status",
        required: true,
        maxSelect: 1,
        values: ["OPEN", "CLOSED", "PAID"],
      }),
      new NumberField({
        name: "total_amount",
        required: true,
      }),
      new NumberField({
        name: "paid_amount",
        required: false,
      })
    ],
  });

  app.save(collection);

  // 2. Add invoice_id to transactions
  const txCollection = app.findCollectionByNameOrId("transactions");
  txCollection.fields.add(new RelationField({
    name: "invoice_id",
    required: false,
    collectionId: collection.id,
    cascadeDelete: false,
    maxSelect: 1,
  }));

  app.save(txCollection);

}, (app) => {
  // 1. Remove invoice_id from transactions
  const txCollection = app.findCollectionByNameOrId("transactions");
  txCollection.fields.removeByName("invoice_id");
  app.save(txCollection);

  // 2. Delete invoices collection
  const invoicesCollection = app.findCollectionByNameOrId("invoices");
  app.delete(invoicesCollection);
});
