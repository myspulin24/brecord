# Bezpečnost

## Jak nahlásit chybu

**Nezakládejte veřejný issue.** U bezpečnostní chyby by to znamenalo
zveřejnit ji dřív, než je co nainstalovat. Použijte
[soukromé hlášení zranitelnosti](https://github.com/myspulin24/brecord/security/advisories/new).
Vidí ho jen správce repozitáře.

Pomůže verze z *Nastavení → Obecné → Aktualizace*, systém, postup a co se
stalo místo toho, co se stát mělo.

## Co čekat

BRecord dělá jeden člověk ve volném čase, proto tu nejsou slíbené lhůty.
Platí tohle:

- Opravuje se **jen poslední vydaná verze**. Aktualizace je v aplikaci
  automatická.
- Oprava vyjde jako běžné vydání a v poznámkách bude, čeho se týká.
- Kdo chybu nahlásí, bude uvedený, pokud si to nebude přát jinak.

## Kde se dá něco najít

| Kde | Proč to stojí za pozornost |
| --- | --- |
| **Aktualizace** | `src/updater.js` (electron-updater) stahuje z GitHub Releases a ověřuje SHA-512 z `latest*.yml`. Kdyby šlo podstrčit jiný soubor, je to nález. |
| **Spouštění nástrojů** | `src/core/proc.js` a `src/core/cli-tools.js` spouštějí `claude`, `codex` a `whisper-cli` s pevnými argumenty, na Windows přes `cmd.exe` s escapováním. Propašovat do nich cokoli jiného je nález. |
| **Okno aplikace** | `src/ui/` vykresluje cizí text (názvy poznámek, výstup CLI, poznámky k vydání) jen přes `textContent`; okna běží s kontextovou izolací a sandboxem. |
| **Nativní pomocník** | `src/native/win-loopback.cs` se při prvním použití zkompiluje do `~/.brecord/bin`. |

## Co chybou není

- **„Neznámý vydavatel“ a Gatekeeper.** Instalátory nemají komerční podpis;
  popsané v [README](README.md#stažení).
- **Text přepisu odchází poskytovateli shrnutí**, kterého si zvolíte
  (Anthropic přes Claude Code, OpenAI přes Codex). S Ollamou nikam.
- **Kontrola aktualizací sahá na GitHub.** Vypíná se v Nastavení nebo
  `BRECORD_AUTO_UPDATE=0`.
