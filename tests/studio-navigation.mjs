// Follow the same disclosure -> section-link path as a Studio user.
export async function openStudioSection(page, name, scope = '#sidebar') {
  const link = page.locator(scope).getByRole('link', { name, exact: true, includeHidden: true });
  await link.waitFor({ state: 'attached' });
  const group = link.locator('xpath=ancestor::details[contains(@class, "nav-group")]');
  if (await group.count() && !await group.evaluate(node => node.open)) {
    await group.locator('summary').click();
  }
  await link.click();
}
