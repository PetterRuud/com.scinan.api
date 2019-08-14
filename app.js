const Homey = require('homey');

class ScinanApp extends Homey.App {
  onInit() {
    console.log('Successfully init Scinan version: %s', Homey.app.manifest.version);
  }
}

module.exports = ScinanApp;
