//API V2 Error codes
const ERROR_CODES = {
    "0": "Success",
    "1": "Password Incorrect Multiple Times", 
    "404": "url not found", 
    "10002": "Need Token",  
    "10003": "Token Expired",  
    "20007": "Password Incorrect",  
    "20014": "User Does Not Exist",
    "30031": "Sign hash is invalid",
    
};
const MODES = {
  COMFORT: 'comfort',
  AUTO: 'auto',
  DAY_OR_NIGHT: 'day_or_night',
};

const SENSORS = {
  ON_OFF: '01',
  TARGET_TEMPERATURE: '02',
  AWAY: '03',
  MODE: '12',
  //UNKNOWN: '06', //control_data: {"value":"1,1"}
  //PROBABLE split from UNKNOWN {"value":"?,?"}
  //PROGRAM (AUTO): '08', //control_data: {"value":"1,1,06:00,27,09:00,16,15:00,27,23:00,16"}
  //PROBABLE split from PROGRAM {"value":"?,?,HH:MM,temp?,HH:MM,temp,HH:MM,temp,HH:MM,temp"} 


};

// 60w / m2
const ENERGY_USAGE = 60;

const LIST_URL_V2 = 'http://api.saswell.com.cn/v2.0/device/list';
const AUTHORIZATION_URL_V2 = 'http://api.saswell.com.cn/v2.0/user/login';
const CONTROL_URL_V2 = 'http://api.saswell.com.cn/v2.0/sensor/control';
const USER_AGENT_V2 = 'Thermostat_iOS/6.2.0 (iPhone; iOS 16.6.1; Scale/3.00)';
const COMPANY_ID = '1038'; //1038 = Thermostat
const APP_KEY = '100027';
const API_VERSION = 'v2';
const REGISTER_URL = 'http://api.saswell.com.cn/v2.0/user/register_email';
/* Required Form returns result_code 0 if ok?
app_key
company_id
email
imei 
password
sign
timestamp
*/

module.exports = {
  MODES,
  SENSORS,  
  ENERGY_USAGE,
  LIST_URL_V2,
  AUTHORIZATION_URL_V2,
  CONTROL_URL_V2,
  USER_AGENT_V2,
  COMPANY_ID,
  APP_KEY,
  API_VERSION,
  ERROR_CODES
}
