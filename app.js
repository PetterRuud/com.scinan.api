const Homey = require('homey');

class ScinanApp extends Homey.App {
  async onInit() {
    this.log('Successfully init Scinan version:', Homey.manifest.version);
  }
}

module.exports = ScinanApp;
