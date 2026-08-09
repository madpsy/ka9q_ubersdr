'use strict';

// The chooser page's whole world: a typed surface over IPC. Receiver windows
// get no preload at all — the v2 UI runs exactly as it does in a browser.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ubersdr', {
    appInfo: () => ipcRenderer.invoke('app:info'),
    saved: () => ipcRenderer.invoke('instances:saved'),
    directory: () => ipcRenderer.invoke('instances:directory'),
    lan: () => ipcRenderer.invoke('instances:lan'),
    resolve: (input, opts) => ipcRenderer.invoke('instances:resolve', input, opts),
    connect: (desc) => ipcRenderer.invoke('instances:connect', desc),
    update: (id, patch) => ipcRenderer.invoke('instances:update', id, patch),
    disconnect: (id) => ipcRenderer.invoke('instances:disconnect', id),
    remove: (id) => ipcRenderer.invoke('instances:remove', id),
    sharedPrefs: () => ipcRenderer.invoke('prefs:shared'),
    setSharedPrefs: (on) => ipcRenderer.invoke('prefs:set-shared', !!on),
    onChanged: (cb) => {
        ipcRenderer.on('instances:changed', () => cb());
    },
});
