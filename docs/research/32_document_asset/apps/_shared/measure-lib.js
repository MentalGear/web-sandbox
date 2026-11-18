// What every application measures once the package has given it a URL: where it points and what answers there.
async function sha256(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// What the value is, as the package's code sees it (`documentUrl` may not be a URL object: some bundlers replace it).
function describeValue(documentUrl) {
  return {
    isURLInstance: documentUrl instanceof URL,
    valueType: Object.prototype.toString.call(documentUrl),
    asString: String(documentUrl),
    rawHref: documentUrl.href,
    rawOrigin: documentUrl.origin,
  };
}

export async function measure(documentUrl) {
  const described = describeValue(documentUrl);
  const absolute = new URL(described.asString, location.href);
  const scriptSrc = document.querySelector('script[src]')?.src ?? location.href;
  const result = {
    url: absolute.href,
    ...described,
    appOrigin: location.origin,
    scriptOrigin: new URL(scriptSrc, location.href).origin,
    documentOrigin: absolute.origin,
  };
  try {
    const response = await fetch(documentUrl);
    const bytes = await response.arrayBuffer();
    result.status = response.status;
    result.contentType = response.headers.get('content-type');
    result.length = bytes.byteLength;
    result.sha256 = await sha256(bytes);
  } catch (error) {
    result.error = String(error);
  }
  return result;
}
