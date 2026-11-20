# Picantex

Full-page screenshots, annotation, blur and searchable PDF: a Chrome extension that keeps everything on your computer.
No account, no network, no statistics.

- **Website:** https://picantex.app
- **Chrome Web Store:** https://chromewebstore.google.com/detail/hgkjklfdkjllkonccjfipcfgcjcojlcm
- **Languages:** English, Italiano, Español, Deutsch, Français

This repository contains the source code of the version published on the Chrome Web Store. Each release is tagged
with its version number (for example `v1.8`).

## What it does

- **Capture** the visible area, a selection, a single element or the whole page, even very long pages (captured in
  stages, with the option to continue where you stopped) and web apps that scroll inside an inner panel.
- **Annotate:** arrows, shapes, text, numbered steps, highlights, side notes.
- **Hide data:** blur, pixelate or cover. Text that you hide is also removed from the text layer of the PDF.
- **Real text:** copy the text of the captured page and save a **searchable PDF**.
- **Open and annotate PDFs**, and put several captures together in a multi-page document.
- Save as PNG, JPEG or PDF, or print.

## Privacy

Picantex works entirely in your browser. It has no account, sends nothing to any server, contains no analytics and
loads nothing from the internet: captures, documents and settings stay on your computer. The PDF reader runs in a
sandboxed page that cannot connect to the internet. The privacy policy is at https://picantex.app/privacy.html.

## Install

- **From the Chrome Web Store** (recommended): see the link above. It also works in other Chromium-based browsers
  such as Edge, Brave, Opera and Vivaldi.
- **From this repository:** download or clone it, open `chrome://extensions`, turn on *Developer mode*, choose
  *Load unpacked* and select the folder. There is no build step: the files are used as they are.

## Third-party code

`vendor/pdfjs/` contains [PDF.js](https://github.com/mozilla/pdf.js) by Mozilla, version 6.4.299 (legacy build of the
official `pdfjs-dist` package, files `pdf.min.mjs` and `pdf.worker.min.mjs`), released under the Apache License 2.0:
see `vendor/pdfjs/LICENSE`. Its source code is available from the PDF.js repository.

## How it was made

Picantex is designed by Radu GT (DigitalBanzai) and developed with the help of artificial intelligence models. Every
feature is designed, reviewed and tested before it is released. Comments in the code are mostly in Italian.

## Support and contributions

- **Questions or problems:** open a ticket at https://picantex.app/ticket/ (no account or email needed), or open an
  issue here.
- **Code contributions:** please read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## License

Copyright (C) 2026 Radu GT (DigitalBanzai)

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied
warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.

You should have received a copy of the GNU General Public License along with this program (the `LICENSE` file). If
not, see https://www.gnu.org/licenses/.

---

## In italiano

Picantex è un'estensione per Chrome che cattura pagine intere, le annota, sfoca i dati e salva in PDF ricercabile,
tenendo tutto sul tuo computer: niente account, niente rete, niente statistiche. Questo repository contiene il codice
della versione pubblicata sul Chrome Web Store, sotto licenza GNU GPL versione 3 o successiva. Picantex è progettato
da Radu GT (DigitalBanzai) e sviluppato con l'aiuto di modelli di intelligenza artificiale. Per domande o problemi:
https://picantex.app/ticket/.
