// eslint-disable-next-line import/no-unresolved
const Homey = require('homey');
const Scinan = require('./lib/scinan');
const { debug } = require('./lib/util');

class ScinanApp extends Homey.App {
  onInit() {
    this.Scinan = new Scinan();
    this.token = null;
    this.isAuthenticated = false;
    this.isAuthenticating = false;

    debug(`${Homey.manifest.id} is running..`);
  }

  async connectToScinan() {
    const username = Homey.ManagerSettings.get('username');
    const password = Homey.ManagerSettings.get('password');

    return this.authenticate(username, password);
  }

  async authenticate(username, password) {
    if (username && password && !this.isAuthenticating) {
      try {
        this.isAuthenticating = true;
        this.token = await this.Scinan.getToken(username, password) || null;
        this.isAuthenticated = true;
        debug('Scinan authenticated');
        return true;
      } finally {
        this.isAuthenticating = false;
      }
    }
    return false;
  }

  clear() {
    this.token = null;
  }

  isConnected() {
    return this.isAuthenticated;
  }

  getToken() {
    return this.token;
  }

  getScinan() {
    return this.getScinan;
  }
}

module.exports = ScinanApp;