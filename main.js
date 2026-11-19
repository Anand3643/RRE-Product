const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const path = require('path');
const http = require('http');

let mainWindow = null;
let serverProcess = null;

function waitForServer(port, timeoutMs = 25000) {
  const startTime = Date.now();
  return new Promise((resolve) => {
    const check = () => {
      const req = http.get(`http://127.0.0.1:${port}/api/gateway/info`, (res) => {
        if (res.statusCode === 200) {
          resolve();
        } else {
          retry();
        }
      });
      req.on('error', () => retry());
      req.setTimeout(1500, () => { req.destroy(); retry(); });
      req.end();
    };

    const retry = () => {
      if (Date.now() - startTime > timeoutMs) {
        resolve();
      } else {
        setTimeout(check, 300);
      }
    };

    check();
  });
}

function startBackendServer() {
  // If server is not already running externally, start in-process
  try {
    require('./server.js');
    console.log('[Electron] In-process Tally server started.');
  } catch (err) {
    console.log('[Electron] Server might already be active:', err.message);
  }
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1366,
    height: 820,
    minWidth: 1024,
    minHeight: 700,
    title: 'TallyPrime Gold — Ramraj Enterprises',
    icon: path.join(__dirname, 'tally_icon.ico'),
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
      label: 'Tally (Gateway)',
      submenu: [
        {
          label: 'Gateway of Tally (Esc)',
          accelerator: 'Esc',
          click: () => mainWindow.webContents.executeJavaScript('window.showGateway && window.showGateway(); if(window.closeModal) window.closeModal();')
        },
        {
          label: 'Toggle Modern Dashboard (Alt+D)',
          accelerator: 'Alt+D',
          click: () => mainWindow.webContents.executeJavaScript('window.toggleDashboard && window.toggleDashboard()')
        },
        { type: 'separator' },
        {
          label: 'Alter Company Profile (F3)',
          accelerator: 'F3',
          click: () => mainWindow.webContents.executeJavaScript('window.openAlterCompany ? window.openAlterCompany() : window.openModal("alterCompanyModal")')
        },
        {
          label: 'Users and Passwords (Alt+K)',
          accelerator: 'Alt+K',
          click: () => mainWindow.webContents.executeJavaScript('window.openUserManagement && window.openUserManagement()')
        },
        {
          label: 'Shut Company / Switch User (Ctrl+F3)',
          accelerator: 'Ctrl+F3',
          click: () => mainWindow.webContents.executeJavaScript('window.showLoginView && window.showLoginView()')
        },
        {
          label: 'Start Clean Slate (₹0 Books)',
          click: () => mainWindow.webContents.executeJavaScript('window.startCleanSlate && window.startCleanSlate()')
        },
        { type: 'separator' },
        {
          label: 'Export Tally XML (Alt+E)',
          accelerator: 'Alt+E',
          click: () => mainWindow.webContents.executeJavaScript('window.exportTallyXml && window.exportTallyXml()')
        },
        { type: 'separator' },
        {
          label: 'Exit TallyPrime',
          accelerator: 'Ctrl+Q',
          click: () => app.quit()
        }
      ]
    },
    {
      label: 'Vouchers',
      submenu: [
        { label: 'Contra (F4)', accelerator: 'F4', click: () => mainWindow.webContents.executeJavaScript('window.openVoucher && window.openVoucher("Contra")') },
        { label: 'Payment (F5)', accelerator: 'F5', click: () => mainWindow.webContents.executeJavaScript('window.openVoucher && window.openVoucher("Payment")') },
        { label: 'Receipt (F6)', accelerator: 'F6', click: () => mainWindow.webContents.executeJavaScript('window.openVoucher && window.openVoucher("Receipt")') },
        { label: 'Journal (F7)', accelerator: 'F7', click: () => mainWindow.webContents.executeJavaScript('window.openVoucher && window.openVoucher("Journal")') },
        { label: 'Sales (F8)', accelerator: 'F8', click: () => mainWindow.webContents.executeJavaScript('window.openVoucher && window.openVoucher("Sales")') },
        { label: 'Purchase (F9)', accelerator: 'F9', click: () => mainWindow.webContents.executeJavaScript('window.openVoucher && window.openVoucher("Purchase")') },
        { type: 'separator' },
        { label: 'Debit Note (Alt+F5)', accelerator: 'Alt+F5', click: () => mainWindow.webContents.executeJavaScript('window.openVoucher && window.openVoucher("Debit Note")') },
        { label: 'Credit Note (Alt+F6)', accelerator: 'Alt+F6', click: () => mainWindow.webContents.executeJavaScript('window.openVoucher && window.openVoucher("Credit Note")') }
      ]
    },
    {
      label: 'Reports',
      submenu: [
        { label: 'Balance Sheet (B)', click: () => mainWindow.webContents.executeJavaScript('window.openReport && window.openReport("balance-sheet")') },
        { label: 'Profit & Loss (P)', click: () => mainWindow.webContents.executeJavaScript('window.openReport && window.openReport("profit-loss")') },
        { label: 'Trial Balance (T)', click: () => mainWindow.webContents.executeJavaScript('window.openReport && window.openReport("trial-balance")') },
        { label: 'Stock Summary (S)', click: () => mainWindow.webContents.executeJavaScript('window.openReport && window.openReport("stock-summary")') },
        { label: 'Day Book (D)', click: () => mainWindow.webContents.executeJavaScript('window.openReport && window.openReport("day-book")') },
        { label: 'Ratio Analysis (R)', click: () => mainWindow.webContents.executeJavaScript('window.openReport && window.openReport("ratio-analysis")') },
        { label: 'GST Portal (G)', click: () => mainWindow.webContents.executeJavaScript('window.openReport && window.openReport("gst-portal")') },
        { label: 'Outstandings (O)', click: () => mainWindow.webContents.executeJavaScript('window.openReport && window.openReport("outstandings")') },
        { label: 'Bank Reconciliation (K)', click: () => mainWindow.webContents.executeJavaScript('window.openReport && window.openReport("brs")') }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Theme & Appearance (Alt+T)',
          accelerator: 'Alt+T',
          click: () => mainWindow.webContents.executeJavaScript('window.openThemeSelectorModal && window.openThemeSelectorModal()')
        },
        {
          label: 'Cycle Next Color Palette',
          click: () => mainWindow.webContents.executeJavaScript('window.cycleNextTheme && window.cycleNextTheme()')
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
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
            mainWindow.webContents.executeJavaScript('window.openHelpModal && window.openHelpModal(); setTimeout(() => window.checkForUpdates && window.checkForUpdates(), 300);');
          }
        },
        { type: 'separator' },
        {
          label: 'About TallyPrime Gold',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About TallyPrime Gold',
              message: 'TallyPrime Gold (V5 Edition) — Standalone Desktop',
              detail: 'Company: Ramraj Enterprises\nMode: 100% Offline Standalone (No Internet or External Server Required)\nData Storage: Local PC SQLite (company.db)\nCompany No: 100000 | Tamil Nadu (33)\nNative Tally XML Port: 9000 (ODBC / Tally Protocol)\nFull double-entry integrity & statutory compliance.'
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
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(menu);

  // Auto-retry UI load on slow initial cold boot
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.log(`[Electron] UI load retry (${errorCode}: ${errorDescription})`);
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL('http://127.0.0.1:4000');
      }
    }, 800);
  });

  try {
    await waitForServer(4000, 25000);
    mainWindow.loadURL('http://127.0.0.1:4000');
  } catch (err) {
    console.error('Failed to connect to local server:', err);
    mainWindow.loadURL('http://127.0.0.1:4000');
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    startBackendServer();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
