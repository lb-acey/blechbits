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
	if (typeof source !== "string" || !source.trim())
		throw new Error("Der Plugin-Code ist leer.");
	if (
		typeof pluginName !== "string" ||
		!/^[A-Za-z0-9_]{1,15}$/.test(pluginName)
	) {
		throw new Error(
			"Der Plugin-Name muss 1–15 Zeichen lang sein und darf nur ASCII-Buchstaben, Zahlen und Unterstriche enthalten.",
		);
	}
	const appLine =
		/korg\.app\s*\(\s*(["'])(.*?)\1\s*,\s*(["'])(.*?)\3\s*\)\s*;?/;
	if (!appLine.test(source))
		throw new Error('Im Code wurde kein korg.app("Name", "TOOLS"); gefunden.');
	source = source.replace(
		appLine,
		(_match, _q1, _oldName, q2, group) =>
			`korg.app("${pluginName}", ${q2}${group}${q2});`,
	);
	const { compile } = await import("./src/script/compiler.mjs");
	const { packBlech } = await import("./src/script/archive.mjs");
	const result = compile(source, { name: pluginName });
	if (!result.ok) {
		throw new Error(
			result.errors
				.map((e) => `Zeile ${e.line}, Spalte ${e.column}: ${e.message}`)
				.join("\n"),
		);
	}
	const packed = packBlech(result.blob, source);
	if (!packed.ok)
		throw new Error(
			packed.error?.message || "Die .blech-Datei konnte nicht erstellt werden.",
		);
	const choice = await dialog.showSaveDialog({
		title: "BLECHTRIBE-Plugin speichern",
		defaultPath: `${pluginName}.blech`,
		filters: [{ name: "BLECHTRIBE Plugin", extensions: ["blech"] }],
	});
	if (choice.canceled || !choice.filePath) return { canceled: true };
	const fs = require("node:fs/promises");
	await fs.writeFile(choice.filePath, Buffer.from(packed.bytes));
	return {
		canceled: false,
		filePath: choice.filePath,
		bytes: packed.bytes.length,
	};
});

ipcMain.handle("check-for-updates", async () => {
	return await checkForUpdates();
});

ipcMain.handle("get-app-version", () => {
	return app.getVersion();
});

const CURRENT_VERSION = app.getVersion();
const RELEASES_API =
	"https://api.github.com/repos/lb-acey/blechbits/releases/latest";
const RELEASES_PAGE = "https://github.com/lb-acey/blechbits/releases/latest";

async function checkForUpdates() {
	try {
		const response = await fetch(RELEASES_API, {
			headers: {
				Accept: "application/vnd.github+json",
				"User-Agent": "BlechBits",
			},
			signal: AbortSignal.timeout(5000),
		});

		if (!response.ok) return null;

		const release = await response.json();

		if (release.draft || release.prerelease || !release.tag_name) {
			return null;
		}

		const latestVersion = release.tag_name.replace(/^v/, "");

		const current = CURRENT_VERSION.split(".").map(Number);
		const latest = latestVersion.split(".").map(Number);

		for (let i = 0; i < Math.max(current.length, latest.length); i++) {
			const a = current[i] || 0;
			const b = latest[i] || 0;

			if (b > a) {
				return {
					currentVersion: CURRENT_VERSION,
					latestVersion,
					releaseUrl: RELEASES_PAGE,
					releaseNotes: release.body || "",
				};
			}

			if (b < a) return null;
		}
	} catch (error) {
		console.warn("Update-Prüfung fehlgeschlagen:", error.message);
		return null;
	}
}
