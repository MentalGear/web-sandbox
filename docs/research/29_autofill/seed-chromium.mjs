// Seeds a fresh Chromium profile with the dummies of lib.mjs through the browser's own settings pages (the "Add"
// dialogs of chrome://password-manager and chrome://settings), so no database schema or encryption is assumed, then
// reads the rows back from the profile's databases. Usage: R29_SCRATCH=<dir> [R29_EXTRA_SITES=<origin>,...] bun
// seed-chromium.mjs [profile-name] (each extra site gets the same login)
import { Database } from 'bun:sqlite';
import { rmSync } from 'node:fs';
import { HOST_ORIGIN, SEED, emit, launchChromium, profileDir, sleep } from './lib.mjs';

const dir = profileDir(process.argv[2]);
rmSync(dir, { recursive: true, force: true });
const ctx = await launchChromium(dir);
emit('seed.run', { version: ctx.browser()?.version(), dir, date: new Date().toISOString() });
const page = ctx.pages()[0] ?? (await ctx.newPage());

async function addPassword(site) {
    await page.goto('chrome://password-manager/passwords');
    await page.locator('#addPasswordButton').click();
    await page.locator('#websiteInput input').fill(site);
    await page.locator('#usernameInput input').fill(SEED.login.username);
    await page.locator('#passwordInput input').fill(SEED.login.password);
    await sleep(300);
    await page.locator('#addButton').click();
    await sleep(800);
}

async function addAddress() {
    const a = SEED.address;
    await page.goto('chrome://settings/addresses');
    await page.locator('#addAddress').click();
    const field = (label) => page.locator(`cr-input[label="${label}"] input`);
    await field('Name').fill(a.name);
    await field('Organization').fill(a.organization);
    await page.locator('cr-textarea[label="Street address"] textarea').fill(a.street);
    await field('City').fill(a.city);
    await field('State').fill(a.state);
    await field('ZIP code').fill(a.zip);
    await field('Phone').fill(a.phone);
    await field('Email').fill(a.email);
    await sleep(300);
    await page.locator('#saveButton').click();
    await sleep(800);
}

async function addCard() {
    const c = SEED.card;
    await page.goto('chrome://settings/payments');
    await page.locator('#addCreditCard').click();
    await page.locator('#numberInput input').fill(c.number);
    await page.locator('select#month').selectOption(c.month);
    await page.locator('select#year').selectOption(c.year);
    await page.locator('#cvcInput input').fill(c.cvc);
    await page.locator('#nameInput input').fill(c.name);
    await sleep(300);
    await page.locator('#saveButton').click();
    await sleep(800);
}

const sites = [HOST_ORIGIN, ...(process.env.R29_EXTRA_SITES ?? '').split(',').filter(Boolean)];
for (const site of sites) await addPassword(site);
await addAddress();
await addCard();

// Read back what the profile now holds, from the browser's own databases once it is closed (the positive control of the
// seeding itself): the login row's site and user, the address's name and the card's holder (no secret is printed).
await ctx.close();
const rows = (file, sql) => {
    const db = new Database(`${dir}/Default/${file}`, { readonly: true });
    const out = db.query(sql).all();
    db.close();
    return out;
};
emit('seed.logins', rows('Login Data', 'SELECT origin_url, signon_realm, username_value, length(password_value) AS encrypted_bytes FROM logins'));
emit('seed.addresses', rows('Web Data', 'SELECT guid, record_type, (SELECT count(*) FROM address_type_tokens t WHERE t.guid = a.guid) AS tokens FROM addresses a'));
emit('seed.address_tokens', rows('Web Data', 'SELECT type, value FROM address_type_tokens WHERE value != \'\' ORDER BY type'));
emit('seed.cards', rows('Web Data', 'SELECT name_on_card, expiration_month, expiration_year, length(card_number_encrypted) AS encrypted_bytes FROM credit_cards'));
