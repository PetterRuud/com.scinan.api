export const MODES = {
  COMFORT: 'comfort',
  AUTO: 'auto',
  DAY_OR_NIGHT: 'day_or_night',
};

export const SENSORS = {
  ON_OFF: '01',
  TARGET_TEMPERATURE: '02',
  AWAY: '03',
  MODE: '12',
};

// 60w / m2
export const ENERGY_USAGE = 60;

export const LIST_URL = 'https://api.scinan.com/v1.0/devices/list';
export const AUTHORIZATION_URL = 'https://api.scinan.com/oauth2/authorize';
export const CONTROL_URL = 'https://api.scinan.com/v1.0/sensors/control';
export const REDIRECT_URI = 'http://localhost.com:8080/testCallBack.action';
export const USER_AGENT = 'Thermostat/3.1.0 (iPhone; iOS 11.3; Scale/3.00)';
export const CLIENT_ID = '100002';
