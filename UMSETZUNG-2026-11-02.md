# Audit-Umsetzung: Stand 2. November 2026

Der Ausgangsbericht `AUDIT-2026-11-02.md` beschreibt den alten Stand und bleibt als historische Bestandsaufnahme erhalten.

## Umgesetzt

- Freigaben für Dateilöschungen sind an Store, Zustandsanker, konkrete Einträge, Pfade und Löschrichtungen gebunden. Ändert sich eine genehmigte Menge, wird erneut eine Freigabe verlangt, auch wenn sie unter die übliche Grenze fällt. Die Wartezeit für automatische Freigaben beginnt bei geändertem Plan neu.
- Ordnerfreigaben werden anhand der frisch berechneten lokalen und entfernten Ordnerpfade getrennt geprüft. Eine Dateifreigabe hebt die Ordnergrenze nicht auf. Ordnerfreigaben werden nicht automatisch erteilt.
- Automatische Freigabe von gehaltenen Dateilöschungen ist bei neuen und zuvor nicht explizit konfigurierten Installationen deaktiviert; gespeicherte Einstellungen bleiben erhalten.
- Manifest-Rücklesen akzeptiert kein beliebiges gleich langes JSON mehr. Geschriebene Staging-Dateien werden vor dem Verschieben selbst zurückgelesen und auf SHA-256 geprüft.
- Strukturiertes Manifest-Diagnoselog enthält Strategie, Phase und Größen ohne Manifestinhalt oder Dateipfad; der Supportbericht kategorisiert lokale Manifest- und Staging-Fehler. Der Speichertest behauptet keine nicht nachgewiesene Crash-Dauerhaftigkeit.
- Dokumentation benennt die Backup-, Server- und Adaptergrenzen und vermeidet nicht belegbare Verlustfrei-Versprechen.

## Zweiter Durchgang (Nachprüfung der Parallelisierung)

- Create-Pfad im lokalen Mutator: Das Ziel wurde nur vor dem Transfer geprüft. Legte der Nutzer während des Downloads dieselbe Datei an und schlug der Rename fehl, blieb ein Manifest zurück, und `initializeAndRecover()` brach bei jedem Start mit »Refusing further execution« ab. Jetzt wird das Ziel direkt vor dem Rename erneut geprüft, der Fehlerpfad räumt Staging und Manifest auf, und die Recovery schließt diesen Zustand sicher ab (die fremde Datei bleibt unangetastet). Test: `tests/local-create-race.test.ts`.
- Gemeinsame Freigabe von Datei- und Ordnerlöschungen: `consumeApproval()` verwarf nach den Dateien auch die Ordnerfreigabe, sodass derselbe Zyklus die Ordner erneut zurückhielt. Neu: `consumeFileApproval()` verbraucht nur den Dateianteil. Test: `tests/deletion-hold-combined.test.ts`.
- `reconcileUploadedChunks` kopierte jeden Chunk nur, um dessen Länge zu lesen; jetzt wird die Länge berechnet.
- Neue Invariantentests für die FIFO-Queue über 230 zufällige Pläne (`tests/transfer-queue-invariants.test.ts`): keine Überlappung konfliktierender Pfade/Identitäten oder Barrieren, Worker- und Byte-Grenze, kein Überholen, Ergebnisreihenfolge, sauberes Auslaufen nach Fehlern. Es wurde kein Fehler in der Queue gefunden.
- Der Benchmark deckt jetzt auch die echten Mutatoren mit Latenz pro Request ab (siehe `PARALLEL-SYNC.md`).

## Live-Test gegen einen echten Nextcloud-Server (2. November 2026)

Getestet nur in `Obsidian/_NyraAcceptance/...`, der echte Vault-Ordner wurde nie berührt; Zugangsdaten nur als Umgebungsvariablen.

- **Befund (behoben):** Die bedingte Ordnerlöschung (`If-Match` auf der Collection) schlug auf diesem Server immer fehl (HTTP 412 auch mit dem aktuellen ETag), Remote-Ordner wurden nie gelöscht. Jetzt wird die Fähigkeit pro Sitzung mit einem Wegwerf-Ordner geprüft; ohne Durchsetzung gilt eine doppelte Leerprüfung mit unverändertem ETag. Eine Zurückstellung zählt nicht mehr als Fehler (`deferred`).
- **Befund (behoben):** HTTP 423 (Locked) bei `PUT`/`MKCOL` brach ganze Zyklen ab (7 Abbrüche pro Suite-Lauf); 423 wird jetzt wiederholt. Gleichzeitige Anlage desselben neuen Ordners durch parallele Worker erzeugte 423 und wird serialisiert.
- **Befund (behoben):** Ein fehlgeschlagener Zyklus verwarf bereits verifizierte Geschwister-Transfers; ein späterer lokaler Edit erzeugte einen unechten `concurrent-create`-Konflikt samt Konfliktkopie. Jetzt wird verifizierter Teilfortschritt unter derselben Anker-Prüfung veröffentlicht.
- **Testfehler (behoben):** Das Konfliktszenario erwartete eine offene Prüfung, obwohl die automatische Lösung inzwischen Standard ist; es gibt jetzt je ein Szenario für die manuelle und die automatische Lösung.
- **Ergebnis:** `npm run e2e:live` 25/25 Szenarien im seriellen Modus und mit 4 Workern; `npm run acceptance:live` vollständig bestanden (inkl. Chunk-Upload v2, bedingtem DELETE, gleichzeitigen Writes).
- **Server-Eigenart (nicht behebbar):** Der ETag einer Datei rückt nach einem Schreibvorgang verzögert vor (gemessen bis ca. 1 s). Zwei Clients, die dieselbe Datei innerhalb dieses Fensters schreiben, können sich überschreiben; die ältere Fassung bleibt nur in der Nextcloud-Versionshistorie.

## Weiterhin offen

- Der konkrete Galaxy-A52-Fehler ist nicht reproduziert; weder ein echtes Gerät noch ein Nextcloud-Testserver waren verfügbar. Die Änderungen garantieren nicht, dass dieser Fehler beseitigt ist. Bitte Plugin-, Obsidian- und Android-Version, genauen Fehlertext und das Ergebnis von Einstellungen → Diagnostics → Test this device's storage erfassen. Keine Inhalte oder Zugangsdaten teilen.
- Ein WebDAV-Ordner-DELETE ist nie atomar. Durchsetzende Server bekommen eine bedingte Löschung, andere eine doppelte Leerprüfung (siehe oben). Echte Mehrclient-Rennen mit einem zweiten Client sind weiterhin nicht automatisiert getestet.
- Adapter-Read-back ist kein Nachweis eines `fsync` oder einer atomaren Rename-Garantie nach Stromverlust. Dafür sind dokumentierte Host-Garantien und Geräte-Crash-Tests nötig.
- Live-Nextcloud-Tests, echte mobile Crash-/Resume-Tests, begrenzte sichere Garbage Collection und langfristige Lasttests bleiben Aufgaben des Audit-Plans. Dies ist keine Behauptung, sämtliche Probleme gefunden zu haben.
