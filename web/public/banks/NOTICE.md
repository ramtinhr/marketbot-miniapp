Bank names, Sheba bank codes and SVG logos are vendored from:
https://github.com/IR-Banks/ir-banks-info

Names/codes: src/data/sheba.ts at commit 3289b0702a73c0379adc22c61fd4a07faafd62b8.
Logos: decoded from the published ir-banks-info@1.2.1 npm distribution
(dist/index.es.js), tarball SHA-1 143482874bb4d811f93d303f4ced2e7dd783b4d5.
MIT license reproduced in LICENSE.txt. Bank names and logos remain their
respective owners' trademarks. The card layouts and palettes are app styling,
not reproductions of specific issued debit cards. Historical bank codes are
retained for existing IBANs; a logo is not evidence of ownership or account status.

Lookup and image loading are local; no IBAN is sent to an external logo API.
To refresh: review upstream bank mappings, update web/src/banks.ts, and replace
matching SVGs in this directory, retaining the upstream license and revision.
