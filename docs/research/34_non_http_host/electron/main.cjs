// Research 34's Electron app shell: one window with Electron's default webPreferences (contextIsolation, sandbox, no
// nodeIntegration, webSecurity), and a custom scheme `app:` registered as standard and secure, as an app shell that
// serves its own pages does: app://bundle/<path> answers site/app/<path> (R34_SITE names site/). The driver
// (probe-electron.mjs) navigates the window to the host page on file:, on app: and on http.
const { app, BrowserWindow, net, protocol } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

app.whenReady().then(() => {
    const root = path.join(process.env.R34_SITE, 'app');
    protocol.handle('app', (request) => {
        const url = new URL(request.url);
        const file = path.join(root, path.normalize(decodeURIComponent(url.pathname)));
        if (url.host !== 'bundle' || !file.startsWith(root)) return new Response('not found', { status: 404 });
        return net.fetch(pathToFileURL(file).href);
    });
    const win = new BrowserWindow({ show: false, width: 800, height: 600 });
    win.loadURL('about:blank');
});
app.on('window-all-closed', () => app.quit());
