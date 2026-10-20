// Desktop-test helpers for Monaco-backed body editors. They use real keyboard input and the system clipboard,
// so no editor internals are exposed on the page.
export async function readMonacoText(app, textbox) {
  const page = textbox.page();
  await textbox.focus();
  await page.keyboard.press('Meta+A');
  await page.keyboard.press('Meta+C');
  return app.evaluate(({ clipboard }) => clipboard.readText());
}

export async function setMonacoText(textbox, text) {
  const page = textbox.page();
  await textbox.focus();
  await page.keyboard.press('Meta+A');
  await page.keyboard.insertText(text);
}
