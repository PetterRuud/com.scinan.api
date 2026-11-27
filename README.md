# Saswell and Scinan Controllers
Control Wi-Fi thermostats through the Saswell v2 cloud API used by the Saswell Thermostat app.

## Pairing and local access

Add the thermostat to your Saswell account first, then pair it in Homey through the Saswell Thermostat driver. Existing Homey devices keep their pairing and Flows.

The SAS920FHL-7W-WIFI (device type 9) can also connect directly from Homey Pro over the local network. Enable **Use local network** during pairing or in the device's **Advanced Settings**. Homey looks for the thermostat on its local subnet and checks its device ID before using LAN. If the saved IP stops working, the app checks Homey's MAC discovery results for a new address before starting a subnet sweep. Every candidate must pass the same device ID check. If discovery cannot find it, enter its local IPv4 address under **Thermostat IP address**. Saswell v2 provides backup when available.

## Supported Devices
The thermostats below have been reported to work with the app. Cloud support requires the device to be listed in a Saswell Thermostat account.


#### Saswell
 - SAS920FHL-7W-WIFI

#### Prosmart
 - PST50W

#### Pergo QuickHeat
 - NEQHKITWIFI
 - PGUDLQHKITEU

## Supported features
 - [x] Turn On/Off
 - [x] Set Away/Home
 - [x] View/Set target temperature
 - [x] View mesured tempature
 - [x] View/Set mode (Comfort, Day or Night or Auto)
 - [ ] Program

## Supported Languages:
 - English
 - Norwegian

## Release notes

2.0.0
-  Corrected the "forEach is not a function" during pairing
-  Fixed so token again will be obtained from scinan.
-  Rework of the app, it should now work with the V2 Saswell API (Thermostat App from Saswell)
-  Added two new standard devices. Scinan using API v1 and Saswell using API v2

1.4
- Added Norwegian Locale

1.3
- Added support for Homey Energy
- Fixed sync

1.2
- Small fixes

1.1
- Added mode

1.0
- Initial
