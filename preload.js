const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("blechBits", {
	compileAndSave: (source, pluginName) =>
		ipcRenderer.invoke("compile-and-save-blech", source, pluginName),

	checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),

	getAppVersion: () => ipcRenderer.invoke("get-app-version"),
	openExternal: (url) => ipcRenderer.invoke("open-external", url),
});
