# Third-party notices

The published bundle (`dist/`) includes the following third-party code. Consumers install no
dependency for it: it is compiled into `dist/index.js`.

## es-module-lexer 1.7.0

- Source: https://github.com/guybedford/es-module-lexer (npm `es-module-lexer`, the asm.js build
  exported as `es-module-lexer/js`)
- Used by: `src/lib/module-specifiers.ts`, to find the import specifiers of registered JavaScript
  modules ([ADR-004](docs/ADR-004-files-as-blob-urls.md), module graph amendment)
- Licence: MIT

```
MIT License
-----------

Copyright (C) 2018-2022 Guy Bedford

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
