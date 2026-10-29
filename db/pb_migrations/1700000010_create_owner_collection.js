// D009 requirement 1: auth collection `owner` - identity/password only, one
// record per deployment at the product level. Password-only authentication
// with email identity; every other auth method is explicitly disabled, the
// verification email flow is unused (the BFF never requests verification), and
// all API rules are null as everywhere (clients never reach PocketBase).
migrate((app) => {
  try {
    // Already exists (idempotent, mirrors the init migration's retry safety).
    app.findCollectionByNameOrId("owner");
    return;
  } catch (_) {
    // First run: create the collection below.
  }

  const owner = new Collection({
    name: "owner",
    type: "auth",
    system: false,
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    manageRule: null,
    authRule: "",
    passwordAuth: {
      enabled: true,
      identityFields: ["email"],
    },
    mfa: {
      enabled: false,
      maxAttempts: 1,
      durationSecs: 180,
    },
    otp: {
      enabled: false,
      length: 8,
      durationSecs: 180,
    },
    oauth2: {
      enabled: false,
    },
  });

  app.save(owner);

  // D5: minimum password length 10 is enforced by the collection itself so
  // setup and subsequent resets are bounded even without the BFF check.
  const ownerSaved = app.findCollectionByNameOrId("owner");
  const passwordField = ownerSaved.fields.getByName("password");
  passwordField.min = 10;
  app.save(ownerSaved);
}, (app) => {
  const owner = app.findCollectionByNameOrId("owner");
  app.delete(owner);
});
