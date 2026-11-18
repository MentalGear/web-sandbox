// The tiny application: imports the stand-in package, prints the URL of its document and fetches it.
// (No top-level await: a bundler's classic-script output cannot have one.)
import { documentUrl } from 'fake-sealed';
import { measure } from './measure-lib.js';

measure(documentUrl).then((result) => {
  document.getElementById('out').textContent = JSON.stringify(result, null, 2);
  window.__result = result;
});
