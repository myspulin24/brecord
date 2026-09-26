# Změny

Co v které verzi přibylo nebo se opravilo.

Sekce k dané verzi se stane textem vydání na GitHubu a BRecord ji ukáže
v **Nastavení → Obecné → Aktualizace**, když nabídne novou verzi. Vydání bez
záznamu tady se nesestaví. Píše se pro toho, kdo aplikaci používá: co se
změní v okně, ne které soubory se upravily. Nejnovější verze je nahoře.

## 0.3.0 — nevydáno

První veřejná verze.

### Nahrávání

- **Jedním kliknutím nahraje váš mikrofon i zvuk počítače.** V přepisu pak
  rozliší „Já“ a „Ostatní“, takže je jasné, kdo co slíbil.
- **Vstup i výstup vyberete přímo na domovské obrazovce.** U Teams a Zoomu
  zvolte komunikační zařízení nebo sluchátka, jinak se ostatní nenahrají.
- Při prvním spuštění vás průvodce požádá o přístup k mikrofonu a pomůže
  vybrat zařízení.

### Přepis a shrnutí

- **Přepis běží ve vašem počítači** přes whisper.cpp. Program i model se
  nainstalují z Nastavení.
- **Shrnutí v pěti bodech, rozhodnutí a úkoly s vlastníky** sepíše Claude
  Code nebo Codex, do kterých jste přihlášeni. Bez API klíčů; offline to
  zvládne Ollama.
- Poznámky jsou obyčejný Markdown ve složce `~/MeetingNotes` a vedle nich
  zůstává zvuková nahrávka.

### Aplikace

- **Aktualizace se hledají samy.** Na Windows a v AppImage se nová verze
  stáhne na pozadí a nainstaluje při ukončení; na macOS vás BRecord upozorní
  a nabídne odkaz ke stažení.
- Verze pro Windows, macOS (Apple Silicon i Intel) a Linux (AppImage a deb).
- Tmavý i světlý vzhled a logo BR. Ikona v oznamovací oblasti během
  nahrávání bliká.
