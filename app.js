const Homey = require('homey');

class ScinanApp extends Homey.App {
  onInit() {
    this.log('Successfully init Scinan version:', Homey.app.manifest.version);
  }
}

module.exports = ScinanApp;
