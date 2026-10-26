const invertInput = document.getElementById("invert");
const pluginNameInput = document.getElementById("pluginName");
const convertButton = document.getElementById("convert");
const copyButton = document.getElementById("copy");
const selectAllButton = document.getElementById("selectAll");
const exportBlechButton = document.getElementById("exportBlech");
const output = document.getElementById("output");
const status = document.getElementById("status");
let selectedFile = null;
const updateNotice = document.getElementById("updateNotice");
const updateVersion = document.getElementById("updateVersion");
const openRelease = document.getElementById("openRelease");
const dismissUpdate = document.getElementById("dismissUpdate");

const bitmapInput = document.getElementById("bitmapFile");

const lineNumbers = document.getElementById("lineNumbers");

function updateLineNumbers() {
	const lines = output.value.split("\n").length;

	lineNumbers.textContent = Array.from({ length: lines }, (_, i) => i + 1).join(
		"\n",
	);
}

output.addEventListener("input", updateLineNumbers);
output.addEventListener("scroll", () => {
	lineNumbers.scrollTop = output.scrollTop;
});

updateLineNumbers();

let releaseUrl = "";

async function checkBlechBitsUpdate() {
	try {
		const update = await window.blechBits.checkForUpdates();

		if (!update) return;

		updateVersion.textContent = `Installiert: ${update.currentVersion} · Neu: ${update.latestVersion}`;

		releaseUrl = update.releaseUrl;
		updateNotice.hidden = false;
	} catch (error) {
		console.warn("Update-Prüfung fehlgeschlagen:", error);
	}
}

openRelease.addEventListener("click", () => {
	if (releaseUrl) {
		window.blechBits.openExternal(releaseUrl);
	}
});

dismissUpdate.addEventListener("click", () => {
	updateNotice.hidden = true;
});

checkBlechBitsUpdate();

bitmapInput.addEventListener("change", () => {
	selectedFile =
		bitmapInput.files && bitmapInput.files.length ? bitmapInput.files[0] : null;

	convertButton.disabled = !selectedFile;
	output.value = "";
	copyButton.disabled = true;
	selectAllButton.disabled = true;
	exportBlechButton.disabled = true;
	status.classList.remove("error");
	status.textContent = selectedFile
		? "Datei ausgewählt. Du kannst sie jetzt konvertieren."
		: "";
});

convertButton.addEventListener("click", async () => {
	if (!selectedFile) return;
	try {
		const buffer = await selectedFile.arrayBuffer();
		const pluginName = pluginNameInput.value.trim();
		if (!/^[A-Za-z0-9_]{1,15}$/.test(pluginName)) {
			throw new Error(
				"Der Plugin-Name muss 1–15 Zeichen lang sein und darf nur ASCII-Buchstaben, Zahlen und Unterstriche enthalten.",
			);
		}
		const code = convertBmpToKorgCode(
			new Uint8Array(buffer),
			!invertInput.checked,
			pluginName,
		);
		output.value = code;
		copyButton.disabled = false;
		selectAllButton.disabled = false;
		exportBlechButton.disabled = false;
		status.classList.remove("error");
		status.textContent = "Konvertierung erfolgreich.";
	} catch (error) {
		output.value = "";
		copyButton.disabled = true;
		selectAllButton.disabled = true;
		exportBlechButton.disabled = true;
		status.classList.add("error");
		status.textContent =
			error.message || "Die Bitmap konnte nicht konvertiert werden.";
	}
});

exportBlechButton.addEventListener("click", async () => {
	if (!output.value.trim()) return;
	try {
		const pluginName = pluginNameInput.value.trim();
		const result = await window.blechBits.compileAndSave(
			output.value,
			pluginName,
		);
		if (result.canceled) {
			status.textContent = "Export abgebrochen.";
			return;
		}
		status.classList.remove("error");
		status.textContent = `Fertige .blech-Datei gespeichert (${result.bytes} Bytes).`;
	} catch (error) {
		status.classList.add("error");
		status.textContent = error.message || "Kompilierung fehlgeschlagen.";
	}
});

copyButton.addEventListener("click", async () => {
	if (!output.value) return;
	try {
		await navigator.clipboard.writeText(output.value);
		status.classList.remove("error");
		status.textContent = "Code in die Zwischenablage kopiert.";
	} catch {
		output.focus();
		output.select();
		status.textContent =
			"Automatisches Kopieren nicht möglich. Der Code ist markiert – drücke Strg+C.";
	}
});

selectAllButton.addEventListener("click", () => {
	output.focus();
	output.select();
});

function convertBmpToKorgCode(bytes, inverted, pluginName) {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const need = (offset, length) => {
		if (offset < 0 || offset + length > bytes.length)
			throw new Error("Die BMP-Datei ist beschädigt oder unvollständig.");
	};
	need(0, 54);
	if (view.getUint16(0, true) !== 0x4d42)
		throw new Error("Die ausgewählte Datei ist keine gültige BMP-Datei.");

	const pixelOffset = view.getUint32(10, true);
	const dibSize = view.getUint32(14, true);
	if (dibSize < 40)
		throw new Error("Dieses BMP-Headerformat wird nicht unterstützt.");
	const width = view.getInt32(18, true);
	const signedHeight = view.getInt32(22, true);
	const height = Math.abs(signedHeight);
	const planes = view.getUint16(26, true);
	const bpp = view.getUint16(28, true);
	const compression = view.getUint32(30, true);
	if (width !== 128 || height !== 64)
		throw new Error(
			`Falsche Bildgröße: ${width} × ${height}. Benötigt wird 128 × 64 Pixel.`,
		);
	if (planes !== 1 || bpp !== 1 || compression !== 0)
		throw new Error(
			"Benötigt wird eine unkomprimierte BMP-Datei mit 1 Bit Farbtiefe.",
		);

	const paletteOffset = 14 + dibSize;
	need(paletteOffset, 8);
	const colorsUsed = view.getUint32(46, true);
	if (colorsUsed > 2) throw new Error("Die BMP-Palette ist ungültig.");
	const palette = [];
	for (let i = 0; i < 2; i++) {
		const p = paletteOffset + i * 4;
		need(p, 4);
		const blue = bytes[p],
			green = bytes[p + 1],
			red = bytes[p + 2];
		palette.push((red * 299 + green * 587 + blue * 114) / 1000 >= 128 ? 1 : 0);
	}

	const rowSize = Math.ceil(width / 32) * 4;
	need(pixelOffset, rowSize * height);
	const pixels = Array.from({ length: height }, () => new Array(width).fill(0));
	for (let y = 0; y < height; y++) {
		const bmpY = signedHeight > 0 ? height - 1 - y : y;
		const rowStart = pixelOffset + bmpY * rowSize;
		for (let x = 0; x < width; x++) {
			const byte = bytes[rowStart + (x >> 3)];
			const paletteIndex = (byte >> (7 - (x & 7))) & 1;
			let pixel = palette[paletteIndex];
			if (inverted) pixel = pixel ? 0 : 1;
			pixels[y][x] = pixel;
		}
	}

	const arrays = [];
	for (let block = 0; block < 8; block++) {
		const values = [];
		for (let x = 0; x < width; x++) {
			let value = 0;
			for (let bit = 0; bit < 8; bit++) {
				value |= pixels[block * 8 + bit][x] << bit;
			}
			values.push(value);
		}
		arrays.push(`const bitmap${block} = [${values.join(", ")}];`);
	}

	const drawLines = arrays
		.map((_, i) => `  korg.display.bitmap(bitmap${i}, 0, ${i * 8}, 128);`)
		.join("\n");
	return [
		`korg.app("${pluginName}", "TOOLS");`,
		"",
		...arrays,
		"",
		"function show() {",
		"  korg.display.clear();",
		drawLines,
		"}",
		"",
		'korg.onEvent("open", () => {',
		"  show();",
		"});",
		"",
	].join("\n");
}
