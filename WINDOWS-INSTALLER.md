# BlechBits – Windows Installer

## Windows-App erstellen

Voraussetzung: Node.js (LTS) und npm.

1. ZIP-Datei entpacken.
2. Im Ordner `blechbits_work` ein Terminal öffnen.
3. Abhängigkeiten installieren:
   ```powershell
   npm install
   ```
4. Installer **und** portable Version bauen:
   ```powershell
   npm run build:win
   ```

Die Dateien werden im Ordner `dist` erstellt. Der Installer heißt üblicherweise `BlechBits Setup 1.0.0.exe`. Beim Installieren kannst du den Installationsordner auswählen; Desktop- und Startmenü-Verknüpfungen werden angeboten.

### Nur den Installer erstellen
```powershell
npm run build:win:installer
```

### Nur die portable Version erstellen
```powershell
npm run build:win:portable
```

**Hinweis:** Diese ZIP enthält den Quellcode und die Build-Konfiguration, nicht bereits eine fertig gebaute Windows-EXE. Der Build sollte unter Windows ausgeführt und anschließend getestet werden.
