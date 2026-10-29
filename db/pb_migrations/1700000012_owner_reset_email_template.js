// D009 requirement 6: password reset links return to the hosted Obol web client,
// which reads `resetToken` and submits it to the BFF's confirm-password-reset route.
// PocketBase interpolates AppURL from its private settings and Token from the reset flow.
migrate((app) => {
  const owner = app.findCollectionByNameOrId("owner");
  owner.resetPasswordTemplate = {
    subject: "Reset your Obol password",
    body: [
      "<p>Hello,</p>",
      "<p>Use the link below to choose a new password for your Obol server owner account:</p>",
      '<p><a href="{{.AppURL}}/?resetToken={{.Token}}">Reset your Obol password</a></p>',
      "<p>If you did not request this, ignore this email.</p>",
    ].join("\n"),
  };
  app.save(owner);
}, (app) => {
  const owner = app.findCollectionByNameOrId("owner");
  owner.resetPasswordTemplate = {
    subject: "Reset your password",
    body: [
      "<p>Hello,</p>",
      '<p>Use the password reset link in your Obol web app.</p>',
      "<p>If you did not request this, ignore this email.</p>",
    ].join("\n"),
  };
  app.save(owner);
});
