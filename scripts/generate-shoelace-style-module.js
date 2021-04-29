/**
 * @license
 * Copyright 2021 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

// Shoelace does not currently include any default styling with its components,
// and requires the top-level app to import a stylesheet that sets custom
// properties on :root. This script updates the Shoelace stylesheet to instead
// use a :host selector, and to make it importable as a Lit CSSStyleResult so
// that we can use Shoelace components in an encapsulated way.
//
// See https://github.com/shoelace-style/shoelace/issues/437 and
// https://github.com/shoelace-style/shoelace/issues/438.

import {createRequire} from 'module';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as url from 'url';

const require = createRequire(import.meta.url);
const thisDir = path.dirname(url.fileURLToPath(import.meta.url));

(async () => {
  const shoelaceDistDir = path.dirname(
    require.resolve('@shoelace-style/shoelace')
  );
  const baseThemePath = path.join(shoelaceDistDir, 'themes', 'base.css');
  let css = await fs.readFile(baseThemePath, 'utf8');
  css = css.replace(/:root/g, ':host').trim();
  const ts = `import {css} from 'lit-element';

export const shoelaceBaseTheme = css\`${css}\`;
`;
  const outPath = path.resolve(
    thisDir,
    '..',
    'src',
    'lib',
    'shoelace-base-theme.ts'
  );
  await fs.writeFile(outPath, ts, 'utf8');
})();
