'use strict';

const { app, BrowserWindow, session } = require('electron');
const path = require('path');
const https = require('https');

const electronArgv = process.argv.slice(2);
const headlessMode = electronArgv.includes('--headless');

function getPortFromArgv(argv) {
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--port' && argv[i + 1]) return parseInt(argv[i + 1], 10);
        const m = argv[i].match(/^--port=(\d+)$/);
        if (m) return parseInt(m[1], 10);
    }
    return null;
}

const userPort = getPortFromArgv(electronArgv);
const serverPort = userPort !== null ? userPort : 8086;

// Communicate data path to meshcentral.js via env var (avoids requiring 'electron' inside meshcentral.js)
const userDataPath = app.getPath('userData');
process.env.MESHCENTRAL_USERDATA = path.join(userDataPath, 'meshcentral-data');

// Belt-and-suspenders: also signal via env var in case argv manipulation is shadowed by Electron internals
process.env.MESHCENTRAL_LAUNCH = '1';

// Rebuild process.argv with clean MeshCentral args
const meshArgs = [];
for (let i = 0; i < electronArgv.length; i++) {
    const arg = electronArgv[i];
    if (arg === '--headless') continue;
    meshArgs.push(arg);
}

// --launch: prevents MeshCentral from spawning a watchdog child process (CRITICAL)
if (!meshArgs.includes('--launch')) meshArgs.push('--launch');

// Default port (avoids requiring root for port 443)
if (userPort === null) meshArgs.push('--port', String(serverPort));

// Disable HTTP redirect server (port 80 requires root); redirserver.js treats port 0 as no-op
if (!electronArgv.some(a => a.startsWith('--redirport'))) meshArgs.push('--redirport', '0');

process.argv.splice(2, process.argv.length - 2, ...meshArgs);

// Start MeshCentral in-process
const meshcentral = require('./meshcentral.js');
meshcentral.mainStart();

function waitForServer(port, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        function attempt() {
            const req = https.get(
                { hostname: '127.0.0.1', port, path: '/', rejectUnauthorized: false },
                () => { resolve(); req.destroy(); }
            );
            req.on('error', () => {
                if (Date.now() - start > timeoutMs) {
                    reject(new Error(`Server did not start within ${timeoutMs}ms`));
                } else {
                    setTimeout(attempt, 500);
                }
            });
            req.end();
        }
        attempt();
    });
}

let mainWindow = null;

function createWindow(port) {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        title: 'MeshCentral',
        show: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true },
    });

    // Trust self-signed localhost cert in renderer page loads
    mainWindow.webContents.on('certificate-error', (event, url, error, certificate, callback) => {
        try {
            const host = new URL(url).hostname;
            if (host === '127.0.0.1' || host === 'localhost') {
                event.preventDefault(); callback(true); return;
            }
        } catch (_) {}
        callback(false);
    });

    mainWindow.loadURL(`https://127.0.0.1:${port}/`);
    mainWindow.webContents.once('did-finish-load', () => mainWindow.show());
    mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
    // Trust self-signed localhost cert for fetch/XHR in renderer
    session.defaultSession.setCertificateVerifyProc((request, callback) => {
        const { hostname } = request;
        if (hostname === '127.0.0.1' || hostname === 'localhost') callback(0);
        else callback(-3);
    });

    if (headlessMode) {
        console.log(`MeshCentral running headless on port ${serverPort}`);
        return;
    }

    try {
        await waitForServer(serverPort);
        createWindow(serverPort);
    } catch (err) {
        console.error('Failed to start MeshCentral:', err.message);
        app.quit();
    }
});

app.on('window-all-closed', () => app.quit());

app.on('activate', () => {
    if (mainWindow === null && !headlessMode) {
        waitForServer(serverPort)
            .then(() => createWindow(serverPort))
            .catch(() => app.quit());
    }
});
