// Desktop-test helpers for Monaco-backed body editors. They use real keyboard input and the system clipboard,
// so no editor internals are exposed on the page.
export async function readMonacoText(app, textbox) {
  const page = textbox.page();
  await textbox.focus();
  await page.keyboard.press('Meta+A');
  await page.keyboard.press('Meta+C');
  return app.evaluate(({ clipboard }) => clipboard.readText());
}

// Replaces the whole text by pasting, as a user would; typing would trigger auto-closing quotes and brackets.
export async function setMonacoText(app, textbox, text) {
  const page = textbox.page();
  await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), text);
  await textbox.focus();
  await page.keyboard.press('Meta+A');
  await page.keyboard.press('Meta+V');
}
