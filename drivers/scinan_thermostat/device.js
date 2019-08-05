'use strict';

const Homey = require('homey');
const { Log } = require('homey-log');
const { debug, error } = require('./../../lib/util');
const Room = require('./../../lib/model');

class ScinanDevice extends Homey.Device {
  onInit() {
    this.deviceId = this.getData().id;

    debug(`[${this.getName()}] ${this.getClass()} (${this.deviceId}) initialized`);

    // capabilities
    this.registerCapabilityListener('target_temperature', this.onCapabilityTargetTemperature.bind(this));
    this.registerCapabilityListener('scinan_mode', this.onCapabilityThermostatMode.bind(this));

    // triggers
    this.modeChangedTrigger = new Homey.FlowCardTriggerDevice('scinan_mode_changed');
    this.modeChangedTrigger.register();

    this.modeChangedToTrigger = new Homey.FlowCardTriggerDevice('scinan_mode_changed_to');
    this.modeChangedToTrigger
      .register()
      .registerRunListener((args, state) => args.scinan_mode === state.scinan_mode);

    // conditions
    this.isHeatingCondition = new Homey.FlowCardCondition('scinan_is_heating');
    this.isHeatingCondition
      .register()
      .registerRunListener(() => (this.room && this.room.heatStatus === 1));

    this.isMatchingModeCondition = new Homey.FlowCardCondition('scinan_mode_matching');
    this.isMatchingModeCondition
      .register()
      .registerRunListener(args => (args.scinan_mode === this.room.modeName));

    // actions
    this.setProgramAction = new Homey.FlowCardAction('scinan_set_mode');
    this.setProgramAction
      .register()
      .registerRunListener(args => this.setThermostatMode(args.scinan_program));

    this.refreshTimeout = null;
    this.room = null;
    this.refreshState();
  }

  async refreshState() {
    debug(`[${this.getName()}] Refreshing state`);

    if (this.refreshTimeout) {
      clearTimeout(this.refreshTimeout);
      this.refreshTimeout = null;
    }

    try {
      if (Homey.app.isConnected()) {
        await this.refreshScinanService();
      } else {
        debug(`[${this.getName()}] Scinan not connected`);
        await Homey.app.connectToScinan().then(() => {
          this.scheduleRefresh(10);
        }).catch((err) => {
          error('Error caught while refreshing state', err);
        });
      }
    } catch (e) {
      error('Exception caught', e);
      Log.captureException(e);
    } finally {
      if (this.refreshTimeout === null) {
        this.scheduleRefresh();
      }
    }
  }

  scheduleRefresh(interval) {
    const refreshInterval = interval || Homey.ManagerSettings.get('interval');
    this.refreshTimeout = setTimeout(this.refreshState.bind(this), refreshInterval * 1000);
    debug(`[${this.getName()}] Next refresh in ${refreshInterval} seconds`);
  }

  async refreshScinanService() {
    const scinanApi = Homey.app.getScinanApi();

    return scinanApi.listDevices(this.getData().id)
      .then((room) => {
        debug(`[${this.getName()}] Scinan state refreshed`, {
          comfortTemp: room.comfortTemp,
          programMode: room.programMode,
          awayTemp: room.awayTemp,
          holidayTemp: room.holidayTemp,
          sleepTemp: room.sleepTemp,
          avgTemp: room.avgTemp,
          currentMode: room.currentMode,
          programMode: room.programMode,
          heatStatus: room.heatStatus
        });

        if (this.room && !this.room.modesMatch(room)) {
          debug(`[${this.getName()}] Triggering mode change from ${this.room.modeName} to ${room.modeName}`);
          // not needed, setCapabilityValue will trigger
          // this.modeChangedTrigger.trigger(this, { scinan_mode: room.modeName })
          //   .catch(this.error);
          this.modeChangedToTrigger.trigger(this, null, { scinan_mode: room.modeName })
            .catch(this.error);
        }

        this.room = new Room(room);
        return Promise.all([
          this.setCapabilityValue('measure_temperature', room.avgTemp),
          this.setCapabilityValue('target_temperature', room.targetTemp),
          this.setCapabilityValue('scinan_mode', room.modeName),
          this.setCapabilityValue('scinan_onoff', room.isHeating)
        ]).catch((err) => {
          Log.captureException(err);
        });
      }).catch((err) => {
        error(`[${this.getName()}] Error caught while refreshing state`, err);
      });
  }

  onAdded() {
    debug('device added', this.getState());
  }

  onDeleted() {
    debug('device deleted');
  }

  onCapabilityTargetTemperature(value, opts, callback) {
    debug(`onCapabilityTargetTemperature(${value})`);
    const temp = Math.ceil(value);
    if (temp !== value) { // half degrees isn't supported by Mill, need to round it up
      this.setCapabilityValue('target_temperature', temp);
      debug(`onCapabilityTargetTemperature(${value}=>${temp})`);
    }
    const scinanApi = Homey.app.getScinanApi();
    this.room.targetTemp = temp;
    scinanApi.changeRoomTemperature(this.deviceId, this.room)
      .then(() => {
        debug(`onCapabilityTargetTemperature(${temp}) done`);
        debug(`Changed temp for ${this.room.roomName} to ${temp}: currentMode: ${this.room.currentMode}/${this.room.programMode}, comfortTemp: ${this.room.comfortTemp}, awayTemp: ${this.room.awayTemp}, avgTemp: ${this.room.avgTemp}, sleepTemp: ${this.room.sleepTemp}`);
        callback(null, temp);
      }).catch((error) => {
        debug(`onCapabilityTargetTemperature(${temp}) error`);
        debug(`Change temp for ${this.room.roomName} to ${temp} resultet in error`, error);
        callback(error);
      });
  }

  setThermostatMode(value) {
    return new Promise((resolve, reject) => {
      const scinanApi = Homey.app.getScinanApi();
      this.room.modeName = value;
      Promise.all([
        this.setCapabilityValue('target_temperature', this.room.targetTemp),
        scinanApi.changeRoomMode(this.deviceId, this.room.currentMode)
      ]).then(() => {
        debug(`Changed mode for ${this.room.roomName} to ${value}: currentMode: ${this.room.currentMode}/${this.room.programMode}, comfortTemp: ${this.room.comfortTemp}, awayTemp: ${this.room.awayTemp}, avgTemp: ${this.room.avgTemp}, sleepTemp: ${this.room.sleepTemp}`);
        resolve(value);
      }).catch((error) => {
        debug(`Change mode for ${this.room.roomName} to ${value} resultet in error`, error);
        reject(error);
      });
    });
  }

  onCapabilityThermostatMode(value, opts, callback) {
    this.setThermostatMode(value)
      .then(result => callback(null, result))
      .catch(err => callback(err));
  }
}

module.exports = ScinanDevice;