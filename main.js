const { app, BrowserWindow, shell, ipcMain } = require("electron");
const path = require("node:path");

function createWindow() {
	const win = new BrowserWindow({
		width: 900,
		height: 760,
		minWidth: 700,
		minHeight: 600,
		backgroundColor: "#10131a",
		title: "BlechBits BMP Converter",
		autoHideMenuBar: true,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
		icon: path.join(__dirname, "assets", "icon.png"),
	});
	win.setTitle("BlechBits BMP Converter");

	win.webContents.setWindowOpenHandler(({ url }) => {
		if (
			url.startsWith("https://github.com/") ||
			url.startsWith("https://instagram.com/") ||
			url.startsWith("https://soundcloud.com/")
		) {
			shell.openExternal(url);
		}

		return { action: "deny" };
	});

	win.loadFile(path.join(__dirname, "index.html"));
}

app.whenReady().then(() => {
	createWindow();
	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("open-external", async (event, url) => {
	const parsedUrl = new URL(url);

	if (
		parsedUrl.protocol !== "https:" ||
		!["github.com", "instagram.com", "soundcloud.com"].includes(
			parsedUrl.hostname,
		)
	) {
		throw new Error("Ungültige externe URL");
	}

	await shell.openExternal(url);
});
