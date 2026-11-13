# 0012: Guess a country from the time zone and rerun the ensemble live

Status: accepted.

## Context

The country selector should start with a sensible value without asking the user for
geography, and changing it after a card is processed must update species labels
without reading the photos again.

## Decision

Ship two data tables under `models/labels/`. `countries.json` is the ISO 3166 list
of 249 countries with `alpha2`, `alpha3` and English name, generated from
pycountry 26.2.16 (LGPL-2.1; the output is codes and names). `tz-country.json` maps
418 IANA zones from `zone.tab` to alpha-3 codes and records the tzdata release,
archive URL and SHA-256 that produced it. `us-states.json` lists the 50 states plus
the District of Columbia by USPS code, which is the form geographic rules expect.

`tools/data/countries.py` regenerates all three files. It downloads the pinned
tzdata archive from `https://data.iana.org/time-zones/releases/`, verifies
SHA-256 `01b4a91cec5167ed48c11e8ab78f2048cead78ce94b0cafcad0ae8c5a3044d3d`
for release 2026f, and refuses to write a table when the archive differs. The
tzdata files are public domain. pycountry is declared in the script's own inline
metadata, so it stays a tools-only dependency and does not enter the application
bundle or the shared Python project.

`countryGuess(timeZone, table)` stays pure: it returns the alpha-3 code for an
exact zone key and `undefined` otherwise. It deliberately does not normalise case
or fold aliases; `Intl.DateTimeFormat().resolvedOptions().timeZone` returns the
canonical zone name. `Etc/UTC` is not a geographic country and is absent from the
table, so it yields no filter.

The selector shows the guessed country with the note "Guessed from your time
zone" and shows "Anywhere (no geographic filter)" when the guess is absent. User
choices are controlled by the caller and can be persisted with the session
location. Choosing "Anywhere" also overrides the guess until the view is
recreated.

A location change calls `PhotoPipeline.setLocation`. It saves the location,
recombines every stored result from its retained raw classifier output and
republishes the signals. No worker request is sent, so the inference counter does
not move. A fresh run with the same country chooses the same path because both use
`combine` and the same stored raw classes.

## Verification

Unit tests check Chicago, London, UTC and an unknown zone against both a hand-written
table and the shipped table.
