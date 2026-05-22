migrate((app) => {
  // 1. Criar o Administrador (Superuser no v0.23+)
  const adminEmail = $os.getenv("PB_ADMIN_EMAIL");
  const adminPassword = $os.getenv("PB_ADMIN_PASSWORD");

  if (adminEmail && adminPassword) {
    try {
      app.findAuthRecordByEmail("_superusers", adminEmail);
    } catch (_) {
      const superusers = app.findCollectionByNameOrId("_superusers");
      const admin = new Record(superusers);
      admin.set("email", adminEmail);
      admin.setPassword(adminPassword);
      app.save(admin);
      console.log("🚀 Admin criado via automação!");
    }
  }

  // Helper para injetar campos de sistema obrigatórios no v0.23+
  const systemFields = [
    { name: "id", type: "text", primaryKey: true, system: true },
    { name: "created", type: "autodate", system: true, onCreate: true },
    { name: "updated", type: "autodate", system: true, onCreate: true, onUpdate: true }
  ];

  const baseRules = {
    listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null
  };

  // 2. Definir as Coleções Base (Sem relacionamentos)
  const baseCollections = [
    {
      name: "accounts",
      type: "base",
      ...baseRules,
      fields: [
        ...systemFields,
        { name: "name", type: "text", required: true },
        { name: "type", type: "select", required: true, maxSelect: 1, values: ["checking", "savings", "investment"] },
        { name: "initial_balance", type: "number", required: true }
      ]
    },
    {
      name: "cards",
      type: "base",
      ...baseRules,
      fields: [
        ...systemFields,
        { name: "name", type: "text", required: true },
        { name: "closing_day", type: "number", required: true },
        { name: "due_day", type: "number", required: true },
        { name: "limit", type: "number", required: true }
      ]
    },
    {
      name: "categories",
      type: "base",
      ...baseRules,
      fields: [
        ...systemFields,
        { name: "name", type: "text", required: true },
        { name: "type", type: "select", required: true, maxSelect: 1, values: ["fixed_budget", "variable"] },
        { name: "monthly_budget", type: "number", required: false }
      ]
    },
    {
      name: "recurring_incomes",
      type: "base",
      ...baseRules,
      fields: [
        ...systemFields,
        { name: "name", type: "text", required: true },
        { name: "amount", type: "number", required: true },
        { name: "payday", type: "number", required: true },
        { name: "end_date", type: "date", required: false },
        { name: "status", type: "select", required: true, maxSelect: 1, values: ["active", "ended"] }
      ]
    },
    {
      name: "projects",
      type: "base",
      ...baseRules,
      fields: [
        ...systemFields,
        { name: "name", type: "text", required: true },
        { name: "total_value", type: "number", required: true },
        { name: "status", type: "select", required: true, maxSelect: 1, values: ["active", "completed"] }
      ]
    }
  ];

  // Salva as coleções base primeiro (para gerar os IDs delas no banco)
  baseCollections.forEach((colDef) => {
    try {
      const collection = new Collection(colDef);
      app.save(collection);
    } catch (err) {
      // Ignora erro se já existir (útil em retry)
    }
  });

  // Helper para buscar o ID real da coleção gerado pelo PocketBase
  const getColId = (name) => {
    return app.findCollectionByNameOrId(name).id;
  };

  // 3. Criar a Coleção Transactions (Com as foreign keys usando os IDs reais)
  const transactionsDef = {
    name: "transactions",
    type: "base",
    ...baseRules,
    fields: [
      ...systemFields,
      { name: "title", type: "text", required: true },
      { name: "amount", type: "number", required: true },
      { name: "type", type: "select", required: true, maxSelect: 1, values: ["income", "expense", "transfer"] },
      { name: "status", type: "select", required: true, maxSelect: 1, values: ["pending", "realized"] },
      { name: "expected_date", type: "date", required: true },
      { name: "realized_date", type: "date", required: false },
      { name: "is_recurring", type: "bool", required: false },
      
      // Relacionamentos linkados aos IDs dinâmicos gerados
      { name: "account_id", type: "relation", required: false, collectionId: getColId("accounts"), maxSelect: 1, cascadeDelete: false },
      { name: "card_id", type: "relation", required: false, collectionId: getColId("cards"), maxSelect: 1, cascadeDelete: false },
      { name: "category_id", type: "relation", required: false, collectionId: getColId("categories"), maxSelect: 1, cascadeDelete: false },
      { name: "project_id", type: "relation", required: false, collectionId: getColId("projects"), maxSelect: 1, cascadeDelete: false },
      { name: "recurring_income_id", type: "relation", required: false, collectionId: getColId("recurring_incomes"), maxSelect: 1, cascadeDelete: false }
    ]
  };

  try {
    const transactionsCol = new Collection(transactionsDef);
    app.save(transactionsCol);
    console.log("🚀 Todas as coleções criadas com sucesso!");
  } catch (err) {
    console.error("Erro ao criar coleção transactions", err);
  }

}, (app) => {
  const collections = ["transactions", "recurring_incomes", "projects", "categories", "cards", "accounts"];
  collections.forEach((name) => {
    try {
      const col = app.findCollectionByNameOrId(name);
      app.delete(col);
    } catch (_) {}
  });
});
