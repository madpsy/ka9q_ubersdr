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
    // Goes one way only: the chooser can set or clear a password and is told
    // whether one is set, but never gets a stored one back.
    setPassword: (target, password) => ipcRenderer.invoke('instances:set-password', target, password),
    disconnect: (id) => ipcRenderer.invoke('instances:disconnect', id),
    remove: (id) => ipcRenderer.invoke('instances:remove', id),
    sort: () => ipcRenderer.invoke('instances:sort'),
    setSort: (value) => ipcRenderer.invoke('instances:set-sort', value),
    // Which tab was open, how the directory was sorted, and a home position the
    // operator typed in — remembered across launches.
    // Settings, which the chooser's own page offers — see its cog. No
    // `openAppSettings` here: a desktop has no per-app settings page to send
    // anybody to, and appInfo says so rather than this failing when pressed.
    linkPending: () => ipcRenderer.invoke('links:pending'),
    resetPrefs: () => ipcRenderer.invoke('settings:reset-prefs'),
    prefGet: (key) => ipcRenderer.invoke('settings:pref-get', key),
    prefSet: (key, value) => ipcRenderer.invoke('settings:pref-set', key, value),
    clearReceivers: () => ipcRenderer.invoke('settings:clear-receivers'),
    chooser: () => ipcRenderer.invoke('chooser:state'),
    setChooser: (patch) => ipcRenderer.invoke('chooser:set-state', patch),
    // Where to draw "you", and what the distance column measures from: the
    // typed-in position if there is one, else GeoIP. Null when neither answers.
    // `{ refresh: true }` forgets the GeoIP answer first — see geo:home.
    home: (opts) => ipcRenderer.invoke('geo:home', opts || null),
    onChanged: (cb) => {
        ipcRenderer.on('instances:changed', () => cb());
    },
});
