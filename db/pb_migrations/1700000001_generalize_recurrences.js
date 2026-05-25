migrate((app) => {
  // 1. Pega a coleção pai existente
  const recurrencesCol = app.findCollectionByNameOrId("recurring_incomes");

  // 2. Renomeia para um conceito mais amplo
  recurrencesCol.name = "recurrences";

  // 3. Adiciona a tipagem (Receita ou Despesa)
  recurrencesCol.fields.add(new SelectField({
    name: "type",
    required: true, // Tem que definir se é income ou expense ao criar
    maxSelect: 1, 
    values: ["income", "expense"]
  }));

  // 4. Adiciona de onde vai sair o dinheiro (Cartão ou Conta)
  recurrencesCol.fields.add(new RelationField({
    name: "account_id",
    required: false,
    collectionId: app.findCollectionByNameOrId("accounts").id,
    maxSelect: 1
  }));

  recurrencesCol.fields.add(new RelationField({
    name: "card_id",
    required: false,
    collectionId: app.findCollectionByNameOrId("cards").id,
    maxSelect: 1
  }));

  app.save(recurrencesCol);

  // 5. Atualiza a tabela 'transactions' para refletir a mudança de nome
  const txCollection = app.findCollectionByNameOrId("transactions");
  const relField = txCollection.fields.getByName("recurring_income_id");
  if (relField) {
    relField.name = "recurrence_id"; // Atualiza o nome da foreign key
  }
  app.save(txCollection);

}, (app) => {
  // Lógica de Rollback
  const recurrencesCol = app.findCollectionByNameOrId("recurrences");
  recurrencesCol.name = "recurring_incomes";
  recurrencesCol.fields.removeByName("type");
  recurrencesCol.fields.removeByName("account_id");
  recurrencesCol.fields.removeByName("card_id");
  app.save(recurrencesCol);

  const txCollection = app.findCollectionByNameOrId("transactions");
  const relField = txCollection.fields.getByName("recurrence_id");
  if (relField) {
    relField.name = "recurring_income_id";
  }
  app.save(txCollection);
});
