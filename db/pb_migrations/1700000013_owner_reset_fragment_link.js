// Reset tokens are credentials. Put them in the URL fragment so browsers do not
// send them in HTTP requests, access logs, or same-origin Referer headers.
// The Nuxt web client consumes `resetToken` from the fragment and removes it
// from history before submitting it to the BFF.
migrate((app) => {
  const owner = app.findCollectionByNameOrId("owner");
  owner.resetPasswordTemplate = {
    subject: "Reset your Obol password",
    body: [
      "<p>Hello,</p>",
      "<p>Use the link below to choose a new password for your Obol server owner account:</p>",
      '<p><a href="{{.AppURL}}/#/reset?resetToken={{.Token}}">Reset your Obol password</a></p>',
      "<p>If you did not request this, ignore this email.</p>",
    ].join("\n"),
  };
  app.save(owner);
}, (app) => {
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
});
