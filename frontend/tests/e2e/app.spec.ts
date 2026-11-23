import { expect, test, type Page } from '@playwright/test';
const user = {
  id: '018bcfe5-6800-7abc-8def-0123456789ab',
  display_name: 'Ana Pérez',
  phone: '+50588881234',
  email: null,
  role: 'user',
};
async function prepare(page: Page) {
  const writes: Record<string, unknown>[] = [];
  let vehicles: Record<string, unknown>[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace('/api/v1', '');
    let data: unknown = {};
    if (path === '/auth/otp/request') data = { debug_code: '123456' };
    else if (path === '/auth/otp/verify')
      data = {
        tokens: { access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 900 },
        user,
      };
    else if (path === '/auth/logout') data = {};
    else if (path === '/vehicles' && req.method() === 'POST') {
      const body = req.postDataJSON();
      writes.push(body);
      vehicles.push({ ...body, alias: body.nickname });
      data = vehicles.at(-1);
    } else if (path === '/vehicles') data = { items: vehicles, count: vehicles.length };
    else if (path === '/catalogs/departments' || path === '/catalogs/specialties')
      data = { items: [] };
    else if (path === '/workshops/search')
      data = {
        items: [
          {
            id: 'one',
            slug: 'primero',
            name: 'Taller Patrocinado',
            sponsored: true,
            rating_average: 4.5,
          },
          { id: 'two', slug: 'segundo', name: 'Taller Orgánico A' },
          { id: 'three', slug: 'tercero', name: 'Taller Orgánico B' },
        ],
      };
    else {
      await route.fulfill({
        status: 500,
        json: { code: 'TEST_UNEXPECTED_ENDPOINT', message: `Unexpected ${req.method()} ${path}` },
      });
      return;
    }
    await route.fulfill({ json: data });
  });
  return writes;
}
async function login(page: Page) {
  await page.goto('/#/bienvenida');
  await page.getByRole('link', { name: /Comenzar/ }).click();
  await page.getByLabel('Ocho dígitos de tu teléfono').fill('88881234');
  await page.getByRole('button', { name: 'Enviar código' }).click();
  await page.getByLabel('Código de verificación').fill('123456');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Verificar y continuar' }).click();
  await expect(page.getByRole('heading', { name: 'Tu vehículo, al día' })).toBeVisible();
}
test('welcome, OTP and mobile empty dashboard', async ({ page }) => {
  await prepare(page);
  await login(page);
  await expect(page.getByRole('heading', { name: 'Aquí comienza tu garaje' })).toBeVisible();
  await page.screenshot({ path: 'test-results/dashboard-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('creates a vehicle with a v7 id and actual DTO fields', async ({ page }) => {
  const writes = await prepare(page);
  await login(page);
  await page.getByRole('link', { name: 'Registrar mi primer vehículo' }).click();
  await page.getByLabel('Placa', { exact: true }).fill('M123456');
  await page.getByLabel('Marca', { exact: true }).fill('Toyota');
  await page.getByLabel('Modelo', { exact: true }).fill('Hilux');
  await page.getByRole('button', { name: 'Registrar vehículo' }).click();
  await expect(page.getByRole('heading', { name: 'Toyota Hilux', exact: true })).toBeVisible();
  expect(writes[0]).toMatchObject({
    id: expect.stringMatching(/^[a-f0-9]{8}-[a-f0-9]{4}-7/),
    plate: 'M123456',
    brand: 'Toyota',
    model: 'Hilux',
    vehicle_type: 'automobile',
  });
});
test('keeps sponsored and organic order from the API', async ({ page }) => {
  await prepare(page);
  await login(page);
  await page.getByRole('link', { name: 'Talleres', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Taller Orgánico B' })).toBeVisible();
  await expect(page.locator('.workshop-body h3')).toHaveText([
    'Taller Patrocinado',
    'Taller Orgánico A',
    'Taller Orgánico B',
  ]);
  await expect(page.getByText('Patrocinado', { exact: true })).toBeVisible();
});
test('logout purges private state and protected routes redirect', async ({ page }) => {
  await prepare(page);
  await login(page);
  await page.getByRole('link', { name: 'Mi cuenta', exact: true }).click();
  await page.getByRole('button', { name: 'Cerrar sesión y borrar datos de la sesión' }).click();
  await expect(page.getByRole('heading', { name: /Tu auto/ })).toBeVisible();
  await page.goto('/#/inicio');
  await expect(page.getByRole('heading', { name: /Tu auto/ })).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('test-access');
});
test('shows a useful API connection error', async ({ page }) => {
  await prepare(page);
  await page.route('**/api/v1/auth/otp/request', (route) => route.abort());
  await page.goto('/#/ingresar');
  await page.getByLabel('Ocho dígitos de tu teléfono').fill('88881234');
  await page.getByRole('button', { name: 'Enviar código' }).click();
  await expect(page.getByRole('alert')).toContainText('No podemos conectar con el servidor');
});
