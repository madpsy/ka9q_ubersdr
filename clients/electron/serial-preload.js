'use strict';

// The serial picker page's whole world. Same shape as preload.js: a typed
// surface over IPC, nothing else reachable from the page.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('serialPicker', {
    // The list plus the host of the page that asked for a port. One call: the
    // origin cannot change while the picker is open, so only the list is pushed.
    info: () => ipcRenderer.invoke('serial:info'),
    // '' means "none of them" — the window's own controls close it the same way.
    choose: (portId) => ipcRenderer.send('serial:choose', String(portId || '')),
    onPorts: (cb) => {
        ipcRenderer.on('serial:ports', (_event, ports) => cb(ports));
    },
});
