// Viewer-request function on the distribution's DEFAULT behaviour: everything that is not
// /stream/* answers 404 here, so the distribution never serves (mirrors) the rest of the site.
function handler(event) {
  return { statusCode: 404, statusDescription: 'Not Found' };
}
