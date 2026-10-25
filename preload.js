const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("blechBits", {
  compileAndSave: (source, pluginName) => ipcRenderer.invoke("compile-and-save-blech", source, pluginName),
});
