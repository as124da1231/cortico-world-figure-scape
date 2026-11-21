const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cabinSpeech', {
  subscribe(callback) {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('cabin:speech', listener);
    return () => ipcRenderer.removeListener('cabin:speech', listener);
  },
  report(message) { ipcRenderer.send('cabin:speech-report', message); },
});
