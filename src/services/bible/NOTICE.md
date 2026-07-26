# Heritage Bible reference parser and translation data

`BibleBooks.js` and `BibleReferenceParser.js` are CommonJS ports of the book
metadata and reference parser from
[`edydex/heritage_study_bible`](https://github.com/edydex/heritage_study_bible)
at commit `f3cd93ca949a7189db8bade49501a30023e6343c`.

That source code is MIT licensed. Its license notice is reproduced in
`LICENSE.heritage-study-bible.txt`.

Translation modules have their own rights and attribution requirements.
SyncShow bundles the Heritage per-book JSON for BSB and LSV from the same
pinned revision. The app code remains MIT licensed; the translation text
retains the rights stated below.

## Berean Standard Bible (BSB)

The BSB text is dedicated to the public domain (CC0). Attribution is not
required. The producers' suggested credit is:

> The Holy Bible, Berean Standard Bible (BSB), produced in cooperation with
> Bible Hub, Discovery Bible, OpenBible.com, and the Berean Bible Translation
> Committee. Dedicated to the public domain (CC0). https://berean.bible

Rights: https://berean.bible/licensing.htm

The copied JSON is identified by Heritage revision
`f3cd93ca949a7189db8bade49501a30023e6343c`; its corresponding upstream
monolithic JSON SHA-256 is
`8afd83b240d4ac4168127d4d039896a2245883d431e9125899b6adcbd5b32285`.
Heritage does not record a source revision inside its older BSB source artifact,
so this copy must not be represented as the newer eBible.org BSB edition.

## Literal Standard Version (LSV)

Literal Standard Version (LSV), copyright © 2020 Covenant Press and the
Covenant Christian Coalition. Licensed under Creative Commons
Attribution-ShareAlike 4.0 International (CC BY-SA 4.0):
https://creativecommons.org/licenses/by-sa/4.0/. Source:
https://ebible.org/Scriptures/englsv_vpl.zip.

Converted from eBible.org VPL to normalized JSON; verse-boundary whitespace was
normalized; no intentional wording changes.

The source VPL SHA-256 is
`c00947f8555a6ed1cd9a878b59946a3af0b1b604526252c8f7b89f78ff8af1c6`.
The corresponding Heritage monolithic JSON SHA-256 is
`2916927946cab7f1066a6432b2fea5dd7b1822e712796cec94445b1cce08d71b`.
