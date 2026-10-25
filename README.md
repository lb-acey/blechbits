# BlechBits

Ein Tool zur Konvertierung von Bitmap dateien in Arrays und Erstellung von BLECHTRIBE-Plugins. BlechBits erweitert den bestehenden Workflow um die Möglichkeit, Plugin-Namen anzupassen und fertige `.blech`-Dateien zu erstellen.

## Features

- **BMP-Konvertierung** – Bitmap-Dateien für die Verwendung in BLECHTRIBE-Plugins konvertieren.
- **Eigener Plugin-Name** – Den Namen des Plugins individuell festlegen.
- **Plugin-Kompilierung** – Plugin-Code mit dem BLECHTRIBE-Compiler kompilieren.
- **`.blech`-Export** – Kompilierte Plugins als fertige `.blech`-Datei exportieren.
- **Compiler-Fehler** – Fehlermeldungen mit Zeilen- und Spaltenangaben anzeigen.

## Installation

Ladet euch das neuste Release [HIER](https://github.com/lb-acey/blechbits/releases/latest) runter. Startet die .exe und fertig.
Viel Spaß beim Ab-Blechen

## Von Quellcode Starten

### Voraussetzungen

- [Node.js](https://nodejs.org/) und npm
- Das heruntergeladene oder geklonte BlechBits-Projekt

### Schritte

1. Repository herunterladen oder klonen.
2. Im Projektverzeichnis ein Terminal öffnen.
3. Abhängigkeiten installieren:

   ```bash
   npm install
   ```

4. BlechBits starten:

   ```bash
   npm start
   ```

### Windows-Build

Falls das Projekt das entsprechende Build-Skript enthält, kann eine Windows-Version erstellt werden:

```bash
npm run build:win
```

## Verwendung

1. BlechBits starten.
2. Die gewünschte Bitmap-Datei importieren und konvertieren.
3. Einen Namen für das Plugin festlegen.
4. Den Plugin-Code kompilieren.
5. Die erzeugte `.blech`-Datei speichern.

Der festgelegte Plugin-Name wird als erstes Argument in `korg.app()` verwendet. Beispiel:

```javascript
korg.app("MeinPlugin", "TOOLS");
```

Der Name muss den Vorgaben des BLECHTRIBE-Compilers entsprechen.

## Hinweise

- Nicht beliebiger JavaScript-Code ist mit der BLECHTRIBE-Skriptsprache kompatibel.
- Ob ein Plugin auf dem Zielgerät funktioniert, hängt unter anderem von der verwendeten API und dem Plugin-Code ab.
- Prüfe vor einer Veröffentlichung die Lizenzbedingungen des Originalprojekts sowie aller eingebundenen Komponenten.
- Ich übernehme keinerlei haftung falls ihr eure Electribe wieso auch immer brickt

## Lizenz

Die Lizenz dieses Projekts richtet sich nach der gewählten Projektlizenz und den Lizenzbedingungen des Originalprojekts. Ergänze hier die passende Lizenzdatei und gegebenenfalls erforderliche Copyright-Hinweise.

---

**BlechBits** – BMP-Konvertierung und BLECHTRIBE-Plugin-Erstellung in einem Tool.
