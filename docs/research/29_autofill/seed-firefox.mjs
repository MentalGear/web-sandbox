// Seeds a fresh Firefox profile (Playwright's Firefox, with the prefs of firefox-prefs.mjs) with the dummies of lib.mjs:
// - the login, through about:logins "Create New Login" (the browser's own page). Firefox 159 keeps logins in logins.db
//   (its first start creates it), so a logins.json written beside it is never read: tried (encrypted with the
//   profile's key4.db through the browser's libnss3), and the control filled nothing;
// - the address, in autofill-profiles.json, written while the browser is closed (addresses are stored in clear; schema
//   version 1, the fields of VALID_ADDRESS_FIELDS in the build's FormAutofillStorageBase.sys.mjs);
// - form history (keyed by the field's name, on any site): typed into the host page's own form with real keys and
//   submitted, in the browser.
// Cards are not seeded: Firefox encrypts the card number with the OS key store, which this Linux VM has none of.
// Every store is read back at the end: logins.db's rows, about:logins' list, formhistory.sqlite's rows.
// Usage: R29_SCRATCH=<dir> bun seed-firefox.mjs [profile-name]
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { firefox } from 'playwright';
import { FIREFOX_PREFS } from './firefox-prefs.mjs';
import { HOST_ORIGIN, PORT, SEED, emit, profileDir, sleep, startServer } from './lib.mjs';

/** What a user typed into fields of these names on the host page. */
const TYPED = [['email', SEED.login.username], ['name', SEED.address.name], ['address', SEED.address.street], ['city', SEED.address.city], ['zip', SEED.address.zip], ['phone', SEED.address.phone]];

const dir = profileDir(process.argv[2] ?? 'firefox-profile');
rmSync(dir, { recursive: true, force: true });

// --- the login, through about:logins
const ctx = await firefox.launchPersistentContext(dir, { headless: true, firefoxUserPrefs: FIREFOX_PREFS });
emit('ffseed.run', { version: ctx.browser()?.version(), dir, date: new Date().toISOString() });
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto('about:logins');
await sleep(1500);
await page.locator('create-login-button').click();
await sleep(500);
const item = page.locator('login-item');
await item.locator('input[name="origin"]').fill(HOST_ORIGIN);
await item.locator('input[name="username"]').fill(SEED.login.username);
await item.locator('input[name="password"]').fill(SEED.login.password);
await item.locator('button.save-changes-button').click();
await sleep(1500);
emit('ffseed.about_logins', { listed: (await page.locator('login-list').innerText()).replace(/\s+/g, ' ').slice(0, 300) });

// --- form history, typed and submitted on the host page
const srv = await startServer(PORT);
srv.route('/ff-history', { body: `<!doctype html><meta charset="utf-8"><title>r29 history</title><form method="get" action="/submitted">${
    TYPED.map(([field]) => `<input id="h-${field}" name="${field}">`).join('')}<button id="hb">Save</button></form>` });
srv.route('/submitted', { body: 'submitted' });
await page.goto(`${HOST_ORIGIN}/ff-history`);
for (const [field, value] of TYPED) {
    await page.locator(`#h-${field}`).click();
    await page.keyboard.type(value);
}
await page.locator('#hb').click();
await page.waitForURL(/submitted/);
await sleep(1500);
await ctx.close();
await srv.close();

// --- the address, in clear, while the browser is closed
const a = SEED.address;
const now = Date.now();
writeFileSync(`${dir}/autofill-profiles.json`, JSON.stringify({
    version: 1,
    addresses: [{
        guid: randomUUID().slice(0, 12), version: 1, timeCreated: now, timeLastUsed: now, timeLastModified: now, timesUsed: 1,
        name: a.name, organization: a.organization, 'street-address': a.street, 'address-level2': a.city,
        'address-level1': a.state, 'postal-code': a.zip, country: 'US', tel: `+1${a.phone}`, email: a.email,
    }],
    creditCards: [],
}));

// --- read back
const rows = (file, sql) => {
    try {
        const db = new Database(`${dir}/${file}`, { readonly: true });
        const out = db.query(sql).all();
        db.close();
        return out;
    } catch (e) {
        return { error: String(e).slice(0, 200) };
    }
};
emit('ffseed.logins_db', rows('logins.db', 'SELECT origin, formActionOrigin, length(secFields) AS secFieldsChars FROM loginsL'));
emit('ffseed.formhistory', rows('formhistory.sqlite', 'SELECT fieldname, value FROM moz_formhistory'));
