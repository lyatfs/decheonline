import { expect, test } from '@playwright/test';

test('page loads and shows the game title', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Age of Empires: Rise of Rome');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Age of Empires: Rise of Rome');
  // The canvas is hidden behind the lobby until a game starts.
  await expect(page.getByTestId('game-canvas')).toBeAttached();
  await expect(page.getByTestId('lobby')).toBeVisible();
});
