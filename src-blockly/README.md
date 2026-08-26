# Blockly block

Source of `admin/blockly.js`, the `ifttt` block ioBroker.javascript's Blockly editor shows in its
`sendTo` category. **`admin/blockly.js` is generated - never edit it directly.**

```bash
npm run build:blockly   # type check + bundle into admin/blockly.js
```

`npm run build` runs it too, so a release always ships a bundle that matches this source.

The bundle stays committed: installations from GitHub do not run `prepublishOnly`, so the built file
has to be in the repository.

## Take the types from `blockly`, the runtime from `window`

`blockly` is a **dev** dependency - it contributes types and nothing else:

```ts
import type { Block } from 'blockly/core';

const Blockly = window.Blockly;
```

Never `import * as Blockly from 'blockly/core'` here. The editor loads this file long after it has
created its own Blockly instance, and an import would bundle a *second*, private one. The block would
register itself on that private instance and stay invisible to the editor - with no error anywhere.

The globals the editor provides (`window.Blockly` including its ioBroker extras `Words`, `Translate`
and `Sendto`, plus `window.main` and `window.systemLang`) are declared in `iobroker-blockly.d.ts`.

## Words

`i18n/*.json` holds one file per language, keyed by word - the layout `translate-adapter` expects,
which is why `npm run translate` passes `-b src-blockly/i18n/en.json` next to the admin base file.
`blockly.ts` imports them and turns them inside out into `Blockly.Words` (keyed by word, then
language). A language file may be incomplete; `Blockly.Translate` falls back to English.

`ifttt_help` is not in there - it is a link, not a word. German and Russian point at the
documentation portal instead of the README, so those two are spelled out; every other language falls
back to the English entry.

They are bundled rather than fetched: the editor loads `admin/blockly.js` as a classic script and
`Blockly.Words` has to be filled before the block registers itself, so there is no point at which the
files could be loaded over the network.

## Registering the generator

```ts
Blockly.JavaScript.forBlock.ifttt = iftttToJavaScript;
```

Blockly 10 removed the fallback that used to look generators up as `Blockly.JavaScript.<type>`. The
editor migrates that old slot to `forBlock`, but older editors did so *before* loading any adapter's
`blockly.js`, so a block registered the old way was never migrated and failed with _"generator does
not know how to generate code for block type"_.

## Empty inputs

`value1`..`value3` are optional and the event can be disconnected too. `valueToCode` returns an empty
string for those, so anything built by string concatenation has to leave the part out instead of
emitting `value1: ,` or `"…" + )`. Both used to produce a syntax error that took the user's entire
script down.
