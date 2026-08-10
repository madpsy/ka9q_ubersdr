'use strict';

// The serial picker page's whole world. Same shape as preload.js: a typed
// surface over IPC, nothing else reachable from the page.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('serialPicker', {
    ports: () => ipcRenderer.invoke('serial:ports'),
    // '' means "none of them" — the window's own controls close it the same way.
    choose: (portId) => ipcRenderer.send('serial:choose', String(portId || '')),
    onPorts: (cb) => {
        ipcRenderer.on('serial:ports', (_event, ports) => cb(ports));
    },
});
