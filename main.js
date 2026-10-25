const { app, BrowserWindow, shell, ipcMain, dialog } = require("electron");
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
			preload: path.join(__dirname, "preload.js"),
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


// Compile BLECHTRIBE source with the upstream compiler and save a complete .blech file.
ipcMain.handle("compile-and-save-blech", async (_event, source, pluginName) => {
  if (typeof source !== "string" || !source.trim()) throw new Error("Der Plugin-Code ist leer.");
  if (typeof pluginName !== "string" || !/^[A-Za-z0-9_]{1,15}$/.test(pluginName)) {
    throw new Error("Der Plugin-Name muss 1–15 Zeichen lang sein und darf nur ASCII-Buchstaben, Zahlen und Unterstriche enthalten.");
  }
  const appLine = /korg\.app\s*\(\s*(["'])(.*?)\1\s*,\s*(["'])(.*?)\3\s*\)\s*;?/;
  if (!appLine.test(source)) throw new Error('Im Code wurde kein korg.app("Name", "TOOLS"); gefunden.');
  source = source.replace(appLine, (_match, _q1, _oldName, q2, group) => `korg.app("${pluginName}", ${q2}${group}${q2});`);
  const { compile } = await import("./src/script/compiler.mjs");
  const { packBlech } = await import("./src/script/archive.mjs");
  const result = compile(source, { name: pluginName });
  if (!result.ok) {
    throw new Error(result.errors.map(e => `Zeile ${e.line}, Spalte ${e.column}: ${e.message}`).join("\n"));
  }
  const packed = packBlech(result.blob, source);
  if (!packed.ok) throw new Error(packed.error?.message || "Die .blech-Datei konnte nicht erstellt werden.");
  const choice = await dialog.showSaveDialog({
    title: "BLECHTRIBE-Plugin speichern",
    defaultPath: `${pluginName}.blech`,
    filters: [{ name: "BLECHTRIBE Plugin", extensions: ["blech"] }]
  });
  if (choice.canceled || !choice.filePath) return { canceled: true };
  const fs = require("node:fs/promises");
  await fs.writeFile(choice.filePath, Buffer.from(packed.bytes));
  return { canceled: false, filePath: choice.filePath, bytes: packed.bytes.length };
});
