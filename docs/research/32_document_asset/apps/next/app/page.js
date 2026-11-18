'use client';
// A client component: the package is imported in the browser bundle.
import { useEffect, useState } from 'react';
import { documentUrl } from 'fake-sealed';
import { measure } from '../measure-lib.js';

export default function Page() {
  const [result, setResult] = useState(null);
  useEffect(() => {
    measure(documentUrl).then((measured) => {
      window.__result = measured;
      setResult(measured);
    });
  }, []);
  return <pre id="out">{result ? JSON.stringify(result, null, 2) : 'running'}</pre>;
}
