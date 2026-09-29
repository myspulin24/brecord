# Změny

Co v které verzi přibylo nebo se opravilo.

Sekce k dané verzi se stane textem vydání na GitHubu a BRecord ji ukáže
v **Nastavení → Obecné → Aktualizace**, když nabídne novou verzi. Vydání bez
záznamu tady se nesestaví. Píše se pro toho, kdo aplikaci používá: co se
změní v okně, ne které soubory se upravily. Nejnovější verze je nahoře.

## 0.5.1 — nevydáno

### Přepis a shrnutí

- **Slovník platí i pro shrnutí.** Jména a pojmy ze slovníku dostane i AI,
  která píše shrnutí, takže je napíše správně (třeba SyteLine, ne Sideline).
- **Slovník platí pro celou nahrávku.** Dřív ho whisper bral v potaz jen na
  prvních zhruba 30 sekundách.
- **Opravy častých chyb.** Na nový řádek slovníku napište `správně = špatně`,
  třeba `SyteLine = Sideline`, a chybná varianta se v přepisu sama nahradí.
  U starší poznámky to zabere, když ji necháte znovu shrnout.

## 0.5.0 — 2026-09-29

### Aktualizace

- **Nová verze se nabídne hned po spuštění.** BRecord se při spuštění
  podívá na GitHub, novou verzi stáhne na pozadí a ukáže okno s tím, co je
  nového. Tlačítkem **Nainstalovat a restartovat** se nainstaluje sama
  a BRecord se znovu otevře.
- Když zvolíte **Později**, nainstaluje se sama při ukončení BRecord.
- Během nahrávání ani zpracování nahrávky vás nabídka nevyruší, ukáže se,
  až bude hotovo.
- Když BRecord běží jen v oznamovací oblasti, přijde upozornění. Kliknutím
  se otevře okno s nabídkou.
- Na GitHub se BRecord podívá i při otevření okna, pokud od poslední
  kontroly uběhlo víc než půl hodiny.
- Na macOS okno nabídne stažení ze stránky vydání, protože aplikace není
  podepsaná certifikátem Apple a nemůže se nahradit sama.

### Opravy

- Poznámky k vydání se v aplikaci zobrazují jako přehledný seznam. Dřív se
  odrážky lámaly na kousky.

## 0.4.0 — 2026-09-29

### Poznámky

- **Úkoly k odškrtání.** V Poznámkách → S úkoly otevřete poznámku a úkoly
  označíte jako hotové, přidáte nové, upravíte je nebo smažete. Všechno se
  zapisuje rovnou do Markdownu (`- [x]`), takže to uvidíte v jakémkoli
  editoru. U každé poznámky ukazuje počítadlo, kolik úkolů je hotových.
- **K vyřešení.** Poznámka, které se nepovedl přepis nebo shrnutí, ukáže
  důvod a nabídne opravu: znovu shrnout, zpracovat nahrávku znovu nebo
  otevřít příslušné nastavení.
- **Poznámky se otevírají v Pilcrow**, pokud ho máte nainstalovaný, jinak ve
  výchozí aplikaci. Přepnout to jde v Nastavení → Obecné.
- Opakované shrnutí zachová úkoly, které už jste odškrtli.
- Když se vrátíte z editoru, seznam poznámek se sám obnoví.

### Opravy

- **Zpracování nahrávky má nový ukazatel průběhu:** kruh, který se plynule
  plní podle přepisu. Předtím se kolem ikony točil useknutý rámeček a animace
  při každé změně poskočila.

## 0.3.0 — 2026-09-26

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
