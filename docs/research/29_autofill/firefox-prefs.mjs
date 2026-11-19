/** The prefs Playwright's Firefox turns off (its playwright.cfg), turned back on for research 29. */
export const FIREFOX_PREFS = {
    'signon.rememberSignons': true,
    'signon.autofillForms': true,
    'extensions.formautofill.addresses.supported': 'on',
    'extensions.formautofill.addresses.enabled': true,
    'extensions.formautofill.creditCards.supported': 'on',
    'extensions.formautofill.creditCards.enabled': true,
    'browser.formfill.enable': true,
};
