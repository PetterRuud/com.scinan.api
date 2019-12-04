'use strict';

module.exports.MODES = {
  COMFORT: 'comfort',
  AUTO: 'auto',
  DAY_OR_NIGHT: 'day_or_night',
};
module.exports.LIST_URL = 'https://api.scinan.com/v1.0/devices/list';
module.exports.AUTHORIZATION_URL = 'https://api.scinan.com/oauth2/authorize';
module.exports.CONTROL_URL = 'https://api.scinan.com/v1.0/sensors/control';
module.exports.REDIRECT_URI = 'http://localhost.com:8080/testCallBack.action';
module.exports.USER_AGENT = 'Thermostat/3.1.0 (iPhone; iOS 11.3; Scale/3.00)';
module.exports.CLIENT_ID = '100002';
