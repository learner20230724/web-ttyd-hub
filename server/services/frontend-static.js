const express = require('express');
const path = require('node:path');
const isHashedAsset = relative => /^assets\/(?:[^/]+\/)*[^/]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9.]+$/.test(relative) && !/\.html?$/i.test(relative);

module.exports = function serveFrontend(app, publicDir) {
  app.use(express.static(publicDir, {
    setHeaders(res, filename) {
      const relative = path.relative(publicDir, filename).split(path.sep).join('/');
      // Only build-generated, content-addressed assets are immutable. HTML and
      // unversioned files must validate so deployments always load the new app.
      res.setHeader('Cache-Control', isHashedAsset(relative)
        ? 'private, max-age=31536000, immutable' : 'private, no-cache');
    },
  }));
  app.get(/^\/(?!api).*/, (req, res) => {
    res.set('Cache-Control', 'private, no-cache');
    res.sendFile(path.join(publicDir, 'index.html'));
  });
};
module.exports.isHashedAsset = isHashedAsset;
