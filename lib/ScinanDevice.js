'use strict';
const Homey = require('homey');
const fetch = require('node-fetch');
const { getTimestamp, getStatus } = require('./Utils');
const { LIST_URL, CONTROL_URL, USER_AGENT, MODES, SENSORS, ENERGY_USAGE } = require('./Constants');

class ScinanDevice extends Homey.Device {
  async onInit() {
    this.token = this.homey.settings.get('token');
    this.device = this.getData();
    this.summary = {
      interval: this.getSettings().interval
      };
    const { device } = this;
    this.log(`[${this.getName()}]`, `Connected to device - ID: ${device.id}`);
    this.registerCapabilityListener('onoff', this.onCapabilityOnOff.bind(this));
    this.registerCapabilityListener('target_temperature', this.onCapabilitySetTemperature.bind(this));
    this.registerCapabilityListener('mode', this.onCapabilitySetMode.bind(this));
    this.registerCapabilityListener('away', this.onCapabilitySetAway.bind(this));
    this.getDeviceData();
    this.setUpdateInterval();
  }

  setUpdateInterval() {
    const updateInterval = this.getUpdateInterval();
    console.log(`Creating update interval with ${updateInterval}`);
    this.interval = setInterval(async () => {
      await this.getDeviceData();
    }, updateInterval);
  }

  getUpdateInterval() {
    return Number(this.summary.interval) * 1000 * 60;
  }

  async getDeviceData() {
    const { device, token } = this;
    this.log(`${this.getName()} - Refresh device - ID: ${device.id}`);
    const timestamp = getTimestamp(new Date());

    try {
      const response = await fetch(`${LIST_URL}?format=json&timestamp=${timestamp}&token=${token}`, {
        method: 'GET',
        headers: {
          'User-Agent': USER_AGENT,
        },
      });

      if (response.ok) {
        const result = await response.json();
        const currentDevice = result.find(devices => {
          return devices.id === device.id;
        });
        // this.log(currentDevice);

        const online = currentDevice.online;
        if (online == 1) {
          this.setAvailable();
        } else {
          this.setUnavailable();
        }

        const status = getStatus(currentDevice.status);

        const measure_power = status.onoff ? ENERGY_USAGE * Number(this.getSetting('m2')) : 0;
        // this.log(`device uses ${measure_power}W`);
        this.setCapabilityValue('target_temperature', status.target_temperature).catch(this.error);
        this.setCapabilityValue('measure_temperature', status.measure_temperature).catch(this.error);
        this.setCapabilityValue('onoff', status.onoff).catch(this.error);
        this.setCapabilityValue('mode', this.valueToMode(status.mode)).catch(this.error);
        this.setCapabilityValue('away', status.away).catch(this.error);
        // calculate power
        if (this.hasCapability('measure_power') && typeof measure_power === 'number') {
          this.setCapabilityValue('measure_power', measure_power).catch(this.error);
        }

        return;
      }
    } catch (error) {
      this.log(error);
      throw new Error(error);
    }
  }

  async updateCapabilityValues(capability) {
    const { device, token } = this;
    try {
      let sensor_id = '';
      let control_data = {};

      switch (capability) {
        case 'onoff':
          sensor_id = SENSORS.ON_OFF;
          control_data = `{%22value%22:%22${this.getCapabilityValue('onoff') === true ? '1' : '0'}%22}`;
          break;
        case 'target_temperature':
          sensor_id = SENSORS.TARGET_TEMPERATURE;
          control_data = `{%22value%22:%22${this.getCapabilityValue('target_temperature').toFixed(1).toString().padStart(4, '0')}%22}`;
          break;
        case 'mode':
          sensor_id = SENSORS.MODE;
          control_data = `{%22value%22:%22${this.modeToValue(this.getCapabilityValue('mode'))}%22}`;
          break;
        case 'away':
          sensor_id = SENSORS.AWAY;
          control_data = `{%22value%22:%22${this.getCapabilityValue('away') === true ? '1' : '0'}%22}`;
          break;
      }

      const timestamp = getTimestamp(new Date());

      const response = await fetch(
        `${CONTROL_URL}?control_data=${control_data}&device_id=${device.id}&format=json&sensor_id=${sensor_id}&sensor_type=1&timestamp=${timestamp}&token=${token}`,
        {
          method: 'POST',
          headers: {
            'User-Agent': USER_AGENT,
          },
        },
      );

      if (response.ok) {
        const result = await response.json();
        this.log(result);
        return result;
      }
    } catch (error) {
      this.log(error);
      throw new Error(error);
    }
  }

  async onCapabilityOnOff(value) {
    try {
      await this.setCapabilityValue('onoff', value);
      this.updateCapabilityValues('onoff');
    } catch (error) {
      this.log(error);
      throw new Error(error);
    }
  }

  async onCapabilitySetTemperature(value) {
    try {
      await this.setCapabilityValue('target_temperature', value);
      this.updateCapabilityValues('target_temperature');
    } catch (error) {
      this.log(error);
      throw new Error(error);
    }
  }

  async onCapabilitySetMode(value) {
    try {
      await this.setCapabilityValue('mode', value);
      this.updateCapabilityValues('mode');
    } catch (error) {
      this.log(error);
      throw new Error(error);
    }
  }

  async onCapabilitySetAway(value) {
    try {
      await this.setCapabilityValue('away', value);
      this.updateCapabilityValues('away');
    } catch (error) {
      this.log(error);
      throw new Error(error);
    }
  }

  modeToValue(value) {
    let mode;
    if (value === MODES.COMFORT) {
      mode = 0;
    } else if (value === MODES.AUTO) {
      mode = 1;
    } else if (value === MODES.DAY_OR_NIGHT) {
      mode = 2;
    }
    return mode;
  }
  valueToMode(mode) {
    let value;
    if (mode === 0) {
      value = MODES.COMFORT;
    } else if (mode === 1) {
      value = MODES.AUTO;
    } else if (mode === 2) {
      value = MODES.DAY_OR_NIGHT;
    }
    return value;
  }

  onAdded() {
    this.log('device added');
    this.log('name:', this.getName());
    this.log('class:', this.getClass());
    this.log('data', this.getData());
  }

  onRenamed(name) {
    this.log(`${name} renamed`);
    // await this.updateName();
  }

  async onSettings({oldSettings, newSettings, changedKeys}) {
    const { interval } = this;
    if (changedKeys == 'interval') {
      console.log(`Delete old interval ${oldSettings.interval} and creating new ${newSettings.interval}`);
      this.summary.interval = newSettings.interval;
      clearInterval(interval);
      this.setUpdateInterval();
    }
  }

  onDeleted() {
    const { interval } = this;
    this.log(`${this.name} deleted`);
    clearInterval(interval);
  }
}

module.exports = ScinanDevice;
