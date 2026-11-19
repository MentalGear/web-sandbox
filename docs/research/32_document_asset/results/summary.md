| case | tool version | URL path at run time | answer | bytes equal (fetch) | bytes equal (iframe navigation) | same origin as the app |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| bun-build | 1.4.4 | `/sealed-document.html` | 404 | NO | NO | yes |
| bun-build-html | 1.4.4 | `/sealed-document.html` | 404 | NO | NO | yes |
| bun-dev | 1.4.4 | `file:///tmp/claude-0/-home-user-web-sand` | - | NO | n/a | NO |
| cdn |  | `/node_modules/fake-sealed/sealed-document.html` | 200 text/html | yes | yes | yes |
| esbuild-esm | 0.28.2 | `/sealed-document.html` | 404 | NO | NO | yes |
| esbuild-esm-copy | 0.28.2 | `/sealed-document.html` | 200 text/html | yes | yes | yes |
| esbuild-esm-splitting | 0.28.2 | `/sealed-document.html` | 404 | NO | NO | yes |
| next-build | 16.4.6 | `/_next/static/media/sealed-document.3qmjzogi2loyz.html` | 200 text/html | yes | yes | yes |
| next-build-webpack | 16.4.6 | `/_next/static/media/sealed-document.38f08c4a.html` | 200 text/html | yes | yes | yes |
| next-dev | 16.4.6 | `/_next/static/media/sealed-document.3qmjzogi2loyz.html` | 200 text/html | yes | yes | yes |
| next-dev-webpack | 16.4.6 | `/_next/static/media/sealed-document.38f08c4a.html` | 200 text/html | yes | yes | yes |
| parcel-build | 2.16.4 | `/sealed-document.32cb7bbe.html` | 200 text/html | NO | NO | yes |
| parcel-build-htm | 2.16.4 | `/sealed-document.32cb7bbe.html` | 200 text/html | NO | NO | yes |
| parcel-build-no-optimize | 2.16.4 | `/sealed-document.68e83e65.html` | 200 text/html | NO | NO | yes |
| parcel-build-noext | 2.16.4 | `/sealed-document.48086a9d.` | 200 application/octet-stream | yes | n/a | yes |
| parcel-build-raw-transformer | 2.16.4 | `/sealed-document.fddeeb5b.html` | 200 text/html | NO | NO | yes |
| parcel-dev | 2.16.4 | `/sealed-document.d2ccf0ef.html` | 200 text/html | NO | NO | yes |
| rollup-copy | 4.68.7 | `/sealed-document.html` | 200 text/html | yes | yes | yes |
| rollup-import-meta-assets | 4.68.7 | `/assets/sealed-document-CdaghI9E.html` | 200 text/html | yes | yes | yes |
| rollup-plain | 4.68.7 | `/sealed-document.html` | 404 | NO | NO | yes |
| rollup-plugin-url | 4.68.7 | `/sealed-document.html` | 404 | NO | NO | yes |
| vite-build | 8.3.8 | `/assets/sealed-document-CdaghI9E.html` | 200 text/html | yes | yes | yes |
| vite-build-htm | 8.3.8 | `data:text/html;base64,PCFkb2N0eXBlIGh0bW` | 200 text/html | yes | n/a | NO |
| vite-dev | 8.3.8 | `/node_modules/fake-sealed/sealed-document.html` | 200 text/html | NO | NO | yes |
| vite-dev-htm | 8.3.8 | `/node_modules/fake-sealed/sealed-document.htm` | 200 text/html | yes | yes | yes |
| vite-dev-noprebundle | 8.3.8 | `/node_modules/fake-sealed/sealed-document.html` | 200 text/html | NO | NO | yes |
| vite-preview | 8.3.8 | `/assets/sealed-document-CdaghI9E.html` | 200 text/html | yes | yes | yes |
| webpack-build | 5.112.2 | `/486bcb520bae9fb307b2.html` | 200 text/html | NO | NO | yes |
| webpack-build-htm | 5.112.2 | `/6f38c2be02272e38de98.htm` | 200 text/html | yes | yes | yes |
| webpack-build-html-off | 5.112.2 | `/6f38c2be02272e38de98.html` | 200 text/html | yes | yes | yes |
| webpack-build-rule | 5.112.2 | `/6f38c2be02272e38de98.html` | 200 text/html | yes | yes | yes |
| webpack-dev-server | 5.112.2 | `/6f38c2be02272e38de98.html` | 200 text/html | yes | yes | yes |
