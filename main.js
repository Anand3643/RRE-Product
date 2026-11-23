process.env.NODE_ENV = process.env.NODE_ENV || 'production';
const { app, BrowserWindow, Menu, dialog, shell, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');

// Ensure Windows taskbar grouping uses official App ID
try {
  app.setAppUserModelId('com.rre.tally');
} catch (e) {}

// Hardware acceleration fallback - prevents blank screen on PCs without modern GPU/DirectX drivers
try {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-software-rasterizer');
} catch (e) {}

let mainWindow = null;
let serverInfo = { port: 4000, host: '127.0.0.1' };

// Runtime File Logging in %APPDATA%\TallyPrimeGold\desktop_runtime.log
const appDataRoot = process.env.APPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Roaming') : '.');
const logDir = path.join(appDataRoot, 'TallyPrimeGold');
try { if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true }); } catch (e) {}
const logFilePath = path.join(logDir, 'desktop_runtime.log');

function logDesktop(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(a => (typeof a === 'object' ? JSON.stringify(a) : a)).join(' ')}\n`;
  try { fs.appendFileSync(logFilePath, line); } catch (e) {}
  console.log(...args);
}

process.on('uncaughtException', (err) => {
  logDesktop('[FATAL UNCAUGHT]', err.stack || err.message);
});

process.on('unhandledRejection', (reason) => {
  logDesktop('[UNHANDLED REJECTION]', reason);
});

async function startBackendServer() {
  logDesktop('[Electron] Initializing in-process backend server on loopback 127.0.0.1...');
  try {
    const backend = require('./server.js');
    serverInfo = await backend.startServer(4000, '127.0.0.1');
    logDesktop(`[Electron] Backend server is active at http://${serverInfo.host}:${serverInfo.port}`);
  } catch (err) {
    logDesktop('[Electron] Backend startup warning:', err.message);
  }
}

async function createWindow() {
  logDesktop('[Electron] Creating application window...');
  mainWindow = new BrowserWindow({
    width: 1366,
    height: 820,
    minWidth: 1024,
    minHeight: 700,
    title: 'RRE Entries',
    icon: path.join(__dirname, 'rre_icon.ico'),
    backgroundColor: '#0a192f',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: false
    },
    autoHideMenuBar: false
  });

  // Native application menu
  const menuTemplate = [
    {
      label: 'Gateway',
      submenu: [
        {
          label: 'Main Gateway (Esc)',
          accelerator: 'Esc',
          click: () => mainWindow && mainWindow.webContents.executeJavaScript('window.showGateway && window.showGateway(); if(window.closeModal) window.closeModal();')
        },
        {
          label: 'Toggle Modern Dashboard (Alt+D)',
          accelerator: 'Alt+D',
          click: () => mainWindow && mainWindow.webContents.executeJavaScript('window.toggleDashboard && window.toggleDashboard()')
        },
        { type: 'separator' },
        {
          label: 'Alter Company Profile (F3)',
          accelerator: 'F3',
          click: () => mainWindow && mainWindow.webContents.executeJavaScript('window.openAlterCompany ? window.openAlterCompany() : window.openModal("alterCompanyModal")')
        },
        {
          label: 'Users and Passwords (Alt+K)',
          accelerator: 'Alt+K',
          click: () => mainWindow && mainWindow.webContents.executeJavaScript('window.openUserManagement && window.openUserManagement()')
        },
        {
          label: 'Start Clean Slate (₹0 Books)',
          click: () => mainWindow && mainWindow.webContents.executeJavaScript('window.startCleanSlate && window.startCleanSlate()')
        },
        { type: 'separator' },
        {
          label: 'Export Compatible XML (Alt+E)',
          accelerator: 'Alt+E',
          click: () => mainWindow && mainWindow.webContents.executeJavaScript('window.exportTallyXml && window.exportTallyXml()')
        },
        { type: 'separator' },
        {
          label: 'Exit RRE Entries',
          accelerator: 'Ctrl+Q',
          click: () => app.quit()
        }
      ]
    },
    {
      label: 'Vouchers',
      submenu: [
        { label: 'Contra (F4)', accelerator: 'F4', click: () => mainWindow && mainWindow.webContents.executeJavaScript('window.openVoucher && window.openVoucher("Contra")') },
        { label: 'Payment (F5)', accelerator: 'F5', click: () => mainWindow && mainWindow.webContents.executeJavaScript('window.openVoucher && window.openVoucher("Payment")') },
        { label: 'Receipt (F6)', accelerator: 'F6', click: () => mainWindow && mainWindow.webContents.executeJavaScript('window.openVoucher && window.openVoucher("Receipt")') },
        { label: 'Journal (F7)', accelerator: 'F7', click: () => mainWindow && mainWindow.webContents.executeJavaScript('window.openVoucher && window.openVoucher("Journal")') },
        { label: 'Sales (F8)', accelerator: 'F8', click: () => mainWindow && mainWindow.webContents.executeJavaScript('window.openVoucher && window.openVoucher("Sales")') },
        { label: 'Purchase (F9)', accelerator: 'F9', click: () => mainWindow && mainWindow.webContents.executeJavaScript('window.openVoucher && window.openVoucher("Purchase")') },
        { type: 'separator' },
        { label: 'Debit Note (Alt+F5)', accelerator: 'Alt+F5', click: () => mainWindow && mainWindow.webContents.executeJavaScript('window.openVoucher && window.openVoucher("Debit Note")') },
        { label: 'Credit Note (Alt+F6)', accelerator: 'Alt+F6', click: () => mainWindow && mainWindow.webContents.executeJavaScript('window.openVoucher && window.openVoucher("Credit Note")') }
      ]
    },
    {
      label: 'Reports',
      submenu: [
        { label: 'Balance Sheet (B)', click: () => mainWindow && mainWindow.webContents.executeJavaScript('window.openReport && window.openReport("balance-sheet")') },
        { label: 'Profit & Loss (P)', click: () => mainWindow && mainWindow.webContents.executeJavaScript('window.openReport && window.openReport("profit-loss")') },
        { label: 'Trial Balance (T)', click: () => mainWindow && mainWindow.webContents.executeJavaScript('window.openReport && window.openReport("trial-balance")') },
        { label: 'Stock Summary (S)', click: () => mainWindow && mainWindow.webContents.executeJavaScript('window.openReport && window.openReport("stock-summary")') },
        { label: 'Day Book (D)', click: () => mainWindow && mainWindow.webContents.executeJavaScript('window.openReport && window.openReport("day-book")') },
        { label: 'Ratio Analysis (R)', click: () => mainWindow && mainWindow.webContents.executeJavaScript('window.openReport && window.openReport("ratio-analysis")') },
        { label: 'GST Portal (G)', click: () => mainWindow && mainWindow.webContents.executeJavaScript('window.openReport && window.openReport("gst-portal")') },
        { label: 'Outstandings (O)', click: () => mainWindow && mainWindow.webContents.executeJavaScript('window.openReport && window.openReport("outstandings")') },
        { label: 'Bank Reconciliation (K)', click: () => mainWindow && mainWindow.webContents.executeJavaScript('window.openReport && window.openReport("brs")') },
        { type: 'separator' },
        { label: 'Quotations & Follow-ups (E)', click: () => mainWindow && mainWindow.webContents.executeJavaScript('window.openQuotations && window.openQuotations()') },
        { label: 'New Quotation (Alt+N)', click: () => mainWindow && mainWindow.webContents.executeJavaScript('window.openQuotationEditor && window.openQuotationEditor()') },
        { label: 'Report Center — PDF / CSV (G)', click: () => mainWindow && mainWindow.webContents.executeJavaScript('window.openReportCenter && window.openReportCenter()') }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Theme & Appearance (Alt+T)',
          accelerator: 'Alt+T',
          click: () => mainWindow && mainWindow.webContents.executeJavaScript('window.openThemeSelectorModal && window.openThemeSelectorModal()')
        },
        {
          label: 'Cycle Next Color Palette',
          click: () => mainWindow && mainWindow.webContents.executeJavaScript('window.cycleNextTheme && window.cycleNextTheme()')
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        {
          label: 'Toggle Developer Tools',
          accelerator: 'F12',
          click: () => mainWindow && mainWindow.webContents.toggleDevTools()
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Check for Updates...',
          click: () => {
            mainWindow && mainWindow.webContents.executeJavaScript('window.openHelpModal && window.openHelpModal(); setTimeout(() => window.checkForUpdates && window.checkForUpdates(), 300);');
          }
        },
        { type: 'separator' },
        {
          label: 'About RRE Entries',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About RRE Entries',
              message: 'RRE Entries (V5 Edition) — Enterprise Suite',
              detail: 'RRE Entries (V5 Edition)\nMode: 100% Offline Standalone (No Internet Required)\nData Storage: Local PC SQLite (company.db)\nCompany No: 100000 | Tamil Nadu (33)\nXML Data Sync Port: 9000 (Open Interoperability)\nFull double-entry integrity & Indian GST statutory compliance.\n\nLegal Notice: Tally, TallyPrime, and Tally.ERP 9 are registered trademarks of Tally Solutions Pvt. Ltd. RRE Entries is an independent product developed by RRE and is not affiliated with or endorsed by Tally Solutions Pvt. Ltd.'
            });
          }
        },
        {
          label: 'Open Company Data Folder (Local PC)',
          click: () => {
            const isPackaged = __dirname.includes('app.asar');
            const dataDir = isPackaged
              ? path.join(app.getPath('appData'), 'TallyPrimeGold', 'data', '100000')
              : path.join(__dirname, 'data', '100000');
            shell.openPath(dataDir);
          }
        },
        {
          label: 'View Desktop Runtime Log',
          click: () => {
            shell.openPath(logFilePath);
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(menu);

  const targetUrl = `http://${serverInfo.host}:${serverInfo.port}`;
  let loadRetries = 0;

  // Auto-retry UI load on slow initial cold boot (up to 4 retries, then fallback to local file)
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    logDesktop(`[Electron] UI load did-fail-load (${errorCode}: ${errorDescription}), attempt ${loadRetries + 1}`);
    if (loadRetries < 4) {
      loadRetries++;
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          logDesktop(`[Electron] Retrying loadURL(${targetUrl})...`);
          mainWindow.loadURL(targetUrl);
        }
      }, 1000);
    } else {
      logDesktop('[Electron] Max retries reached. Loading local file fallback...');
      const localFile = path.join(__dirname, 'public', 'index.html');
      mainWindow.loadFile(localFile).catch(fErr => {
        logDesktop('[Electron] Fallback file load error:', fErr.message);
      });
    }
  });

  mainWindow.webContents.on('did-finish-load', () => {
    logDesktop('[Electron] UI loaded successfully!');
  });

  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    if (level >= 2) {
      logDesktop(`[Renderer Console] ${message} (${sourceId}:${line})`);
    }
  });

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    logDesktop('[Electron] Renderer process terminated:', details);
  });

  logDesktop(`[Electron] Loading target URL: ${targetUrl}`);
  mainWindow.loadURL(targetUrl);

  mainWindow.on('closed', () => {
    logDesktop('[Electron] mainWindow closed.');
    mainWindow = null;
  });
}

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  logDesktop('[Electron] Another instance already running. Exiting secondary instance.');
  app.quit();
} else {
  app.on('second-instance', () => {
    logDesktop('[Electron] Second instance requested. Focusing existing window.');
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    logDesktop('[Electron] App ready event fired.');
    await startBackendServer();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => {
    logDesktop('[Electron] before-quit event fired.');
  });

  app.on('window-all-closed', () => {
    logDesktop('[Electron] window-all-closed event fired. Quitting application.');
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
