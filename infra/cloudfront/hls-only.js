// Viewer-request function on the distribution's DEFAULT behaviour: everything that is not
// /stream/* answers 404 here, so the distribution never serves (mirrors) the rest of the site.
// CloudFront calls `handler(event)` by name; nothing in this repo does, hence the lint exemption.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function handler(event) {
  return { statusCode: 404, statusDescription: 'Not Found' };
}
