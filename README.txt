Saswell and Scinan Controllers
Control Wi-Fi thermostats through the Saswell v2 cloud API used by the Saswell Thermostat app.

Add the thermostat to your Saswell account before pairing it through Homey. Existing devices keep their pairing and Flows.

On Homey Pro, the SAS920FHL-7W-WIFI (device type 9) can use a direct local connection with Saswell v2 as a backup. Enable Use local network during pairing or in the device's Advanced Settings. Homey looks for the thermostat on its subnet, verifies its device ID, and remembers the address. If that address stops working, the app checks Homey's MAC discovery results for a new address before starting a subnet sweep. If discovery cannot find it, enter its local IPv4 address under Thermostat IP address.

Supported Devices
The thermostats below have been reported to work with the app. Cloud support requires the device to be listed in a Saswell Thermostat account.

Saswell
 - SAS920FHL-7W-WIFI

Prosmart
 - PST50W

Pergo Quickheat
 - NEQHKITWIFI
 - PGUDLQHKITEU

Supported features
 - [x] Turn On/Off
 - [x] Set Away/Home
 - [x] View/Set target temperature
 - [x] View mesured tempature
 - [x] View/Set mode (Comfort, Day or Night or Auto)
 - [ ] Program

Supported Languages:
 - English
 - Norwegian
