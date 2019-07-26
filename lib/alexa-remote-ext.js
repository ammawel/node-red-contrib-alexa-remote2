const AlexaRemote = require('alexa-remote2');
const util = require('util');
const tools = require('./common.js');
const known = require('./known-color-values.js');
const convert = require('./color-convert.js');
const deltaE = require('./delta-e.js')
const DEBUG_THIS = tools.DEBUG_THIS;

function requireUncached(mod) {
	delete require.cache[require.resolve(mod)];
	return require(mod);
}

// my own implementation to keep track of the value on errors, for debugging
function promisify(fun) {
	return (function() {
		return new Promise((resolve, reject) => {
			fun.bind(this)(...arguments, (err, val) => {
                if(err) {
                    if(typeof err === 'object') {
                        err.value = val;   
                    }
					reject(err);
                }
				else {
					resolve(val);
                }
			});
		});
	});
}

function dateToStringPieces(date = new Date()) {
	const Y = String(date.getFullYear()).padStart(4, '0');
	const M = String(date.getMonth() + 1).padStart(2, '0');
	const D = String(date.getDate()).padStart(2, '0');
	const h = String(date.getHours()).padStart(2, '0');
	const m = String(date.getMinutes()).padStart(2, '0');
	const s = String(date.getSeconds()).padStart(2, '0');
	const u = String(date.getMilliseconds()).padStart(3, '0');
	return [Y, M, D, h, m, s, u];
}

function durationToPieces(dur = 0) {
	const u = dur % 1000, uRem = Math.floor(dur / 1000);
	const s = uRem % 60, sRem = Math.floor(uRem / 60);
	const m = sRem % 60, mRem = Math.floor(sRem / 60);
	const h = mRem % 24, hRem = Math.floor(mRem / 24);
	const d = hRem;
	return [d, h, m, s, u];
}

function piecesToDuration([d, h, m, s, u]) {
	return u +
		s * 1000 +
		m * 1000 * 60 +
		h * 1000 * 60 * 60 +
		d * 1000 * 60 * 60 * 24;
}

function parseDuration(time) {
	switch(typeof time) {
		case 'number': 
			return time * 1000;
		case 'string': 
			const a = time.split(/[^0-9]/).filter(s => s).map(Number);
			const l = a.length;
			if(a.includes(NaN) || l === 0) return NaN;
			return piecesToDuration([
				a[l-4] || 0,
				a[l-3] || 0,
				a[l-2] || 0,
				a[l-1] || 0,
				0
			]);
		default: 
			return NaN;
	}
}

function stringForCompare(str) {
	return String(str).replace(/[^a-z0-9]/ig, '').toLowerCase();
}

function ensureMatch(response, template) {
	if(!tools.matches(response, template)) throw new Error(`unexpected response: "${JSON.stringify(response)}"`);
}

class AlexaRemoteExt extends AlexaRemote
{
	constructor() {
		super(...arguments);

		// blacklist: ^(?:\t|[ ]{4})(?![A-z]*constructor)[A-z]*\((?![^\)]*callback)[^\)]*\)
		const names = [
			// smarthome
			'getSmarthomeDevices', 
			'getSmarthomeEntities', 
			'getSmarthomeGroups',
			'getSmarthomeBehaviourActionDefinitions',
			'discoverSmarthomeDevice',
			'deleteAllSmarthomeDevices',
			// echo
			'getDevices',
			'getMedia',
			'getPlayerInfo',
			'getDeviceNotificationState',
			'getDevicePreferences',
			'getDeviceStatusList',
			'getNotifications',
			'getBluetooth',
			'getWakeWords',
			'renameDevice',
			'deleteDevice',
			'setTunein',
			'setDoNotDisturb',
			'setAlarmVolume',
			'getDoNotDisturb',
			'sendCommand',
			// other
			'getAccount',
			'getContacts',
			'getConversations',
			'getAutomationRoutines',
			'getMusicProviders',
			'getActivities',
			'getHomeGroup',
			'getCards',
			'sendTextMessage',
			'deleteConversation',
		];
		
		for(const name of names) {
			this[name + 'Promise'] = promisify(this[name]);
		}

		this.smarthomeSimplifiedByEntityIdExt = new Map();
		this.colorNameToLabelExt = new Map();
		this.colorTemperatureNameToLabelExt = new Map();
		this.colorNamesExt = new Set();
		this.colorNameToHexExt = new Map();
		this.colorTemperatureNamesExt = new Set();
		this.colorTemperatureNameToKelvinExt = new Map();
		this.routineByIdExt = new Map();
		this.musicProvidersByIdExt = new Map();
		this.deviceByIdExt = new Map();
		this.deviceByNameExt = new Map();
		this.bluetoothStateByIdExt = new Map();
		this.wakeWordByIdExt = new Map();
		this.notificationByIdExt = new Map();
		this.notificationByNameExt = new Map();
		this.notificationUpdatesExt = [];
		this.notificationUpdatesRunning = false;
		this.warnCallback = () => {};
	}

	async initExt(config, proxyActiveCallback = () => {}, warnCallback = () => {}) {
		this.warnCallback = warnCallback;

		const value = await new Promise((resolve, reject) => this.init(config, (err, val) => {
			if (err) {
				// proxy status message is not the final callback call
				// it is also not an actual error
				// so we filter it out and report it our own way
				const begin = `You can try to get the cookie manually by opening http://`;
				const end = `/ with your browser.`;
				const beginIdx = err.message.indexOf(begin);
				const endIdx = err.message.indexOf(end);
				
				if(beginIdx !== -1 && endIdx !== -1) {
					const url = err.message.substring(begin.length, endIdx);
					proxyActiveCallback(url);
				}
				else {
					reject(err);
				}
			}
			else {
				resolve(this.cookieData);
			}
		}));

		const warn = (what => (error => (error.message = `failed to ${what}: ` + error.message, this.warnCallback(error))));

		await Promise.all([
			this.initAccountExt(),
			this.initDevicesExt(),
			this.initNotificationsExt(),
			this.initSmarthomeSimplifiedExt() 	.catch(warn('intialise smarthome simplified')),
			this.initSmarthomeColorsExt()		.catch(warn('intialise smarthome colors')),
		]);

		this.on('ws-notification-change', payload => {
			this.updateNotificationsExt(payload.eventType, payload.notificationId, String(payload.notificationVersion));
		});

		return value;
	}

	async initSmarthomeSimplifiedExt() {
		const [groups, entitiesByEntityId, devicesByApplianceId] = await Promise.all([
			this.getSmarthomeGroupsPromise().then(response => response.applianceGroups),
			this.getSmarthomeEntitiesPromise().then(entities => entities.reduce((o,e) => (o[e.id] = e, o), {})),
			this.getSmarthomeDevicesPromise().then(response => {
				const locations = response.locationDetails;
				if(DEBUG_THIS) tools.log({locations: locations}, 1);
	
				const bridges = Object.values(locations).map(location => location.amazonBridgeDetails.amazonBridgeDetails).reduce((o,v) => Object.assign(o,v), {});
				if(DEBUG_THIS) tools.log({bridges: bridges}, 1);
	
				const devices = Object.values(bridges).map(bridge => bridge.applianceDetails.applianceDetails).reduce((o,v) => Object.assign(o,v), {});
				if(DEBUG_THIS) tools.log({devices: devices}, 1);
	
				return devices;
			})
		]);

		this.smarthomeSimplifiedByEntityIdExt = new Map();
		for(const device of Object.values(devicesByApplianceId)) {
			const properties = [];
			for (const capability of device.capabilities) {
				for (const property of capability.properties.supported) {
					properties.push(property.name);
				}
			}

			const entity = entitiesByEntityId[device.entityId] || {};
			// supportedOperations is enough? we don't care about unsupported operations anyway
			//
			// const uniqueActions = new Set();
			// for(const action of device.actions) {
			// 	uniqueActions.add(action);
			// }
			// for(const action of entity.supportedOperations || []) {
			// 	uniqueActions.add(action);
			// }
			// for(const action of entity.supportedProperties || []) {
			// 	uniqueActions.add(action);
			// }

			if(device.applianceTypes[0] === 'OTHER' && device.manufacturerName === 'AMAZON' && device.driverIdentity && device.driverIdentity.namespace === 'AAA') {
				// this is probably an Echo
				device.applianceTypes[0] = 'ECHO';
			}

			// common
			const entry = {};
			entry.entityId = device.entityId;
			entry.applianceId = device.applianceId;
			entry.name = device.friendlyName;
			entry.type = 'APPLIANCE';
			entry.actions = entity.supportedOperations || [];
			entry.properties = properties;
			entry.applianceTypes = device.applianceTypes;
			// entry.actions = Array.from(uniqueActions);

			this.smarthomeSimplifiedByEntityIdExt.set(entry.entityId, entry);
		}
		for(const group of groups) {
			
			const entry = {};

			// group specific
			const applianceIds = group.applianceIds || [];
			const entityIds = applianceIds.map(id => devicesByApplianceId[id] && devicesByApplianceId[id].entityId).filter(x => x);
			entry.children = entityIds.map(id => this.smarthomeSimplifiedByEntityIdExt.get(id)).filter(x => x);

			const uniqueActions = new Set();
			const uniqueProperties = new Set();
			const uniqueTypes = new Set();
			for (const entity of entry.children) {
				for (const action of entity.actions) uniqueActions.add(action);
				for (const property of entity.properties) uniqueProperties.add(property);
				for (const type of entity.applianceTypes) uniqueTypes.add(type);
			}

			// common
			entry.groupId = group.groupId;
			entry.entityId = group.groupId.substr(group.groupId.lastIndexOf('.') + 1);
			entry.name = group.name;
			entry.type = 'GROUP';
			entry.actions = Array.from(uniqueActions);
			entry.properties = Array.from(uniqueProperties);
			entry.applianceTypes = Array.from(uniqueTypes);

			this.smarthomeSimplifiedByEntityIdExt.set(entry.entityId, entry);
		}
	}

	async initSmarthomeColorsExt() {
		const definitions = await this.getSmarthomeBehaviourActionDefinitionsPromise();

		//tools.log({simplified: this.smarthomeSimplifiedByEntityId});

		// build color names
		// this is not required to succeed
		let colorNameOptions = [];
		let colorTemperatureNameOptions = [];

		colorNameOptions = definitions
			.find(x => x.id === 'setColor').parameters
			.find(x => x.name === 'colorName').constraint.options
			.map(option => {
				const hex = known.colorNameToHex[option.data];
				const rgb = hex && convert.hex2rgb(hex);
				const hsv = rgb && convert.rgb2hsv(rgb);
			
				const value = option.data;
				const label = option.displayName;
				//const label = hex ? `${option.displayName} (${hex})` : option.displayName;
			
				// sort by hue but put grayscale at the back
				let sortkey = !hsv ? Infinity : (hsv[1] !== 0) ? hsv[0] : (hsv[2] + 42);
			
				return {
					value: value,
					label: label,
					color: hex,
					sortkey: sortkey
				};
			})
			.sort((a,b) => a.sortkey - b.sortkey);

		colorTemperatureNameOptions = definitions
			.find(x => x.id === 'setColorTemperature').parameters
			.find(x => x.name === 'colorTemperatureName').constraint.options
			.map(option => {
				const number = known.colorTemperatureNameToKelvin[option.data];
				const value = option.data;
				const label = option.displayName;
				//const label = number ? `${option.displayName} (${number})` : option.displayName;

				return {
					value: value,
					label: label,
					sortkey: number
				};
			})
			.sort((a,b) => a.sortkey - b.sortkey);

		this.colorNameToLabelExt = new Map();
		for(const {value, label} of colorNameOptions) {
			this.colorNameToLabelExt.set(value, label);
		}

		this.colorTemperatureNameToLabelExt = new Map();
		for(const {value, label} of colorTemperatureNameOptions) {
			this.colorTemperatureNameToLabelExt.set(value, label);
		}

		this.colorNamesExt = new Set();
		for(const option of colorNameOptions) {
			this.colorNamesExt.add(option.value);
		}

		this.colorNameToHexExt = new Map();
		for(const [name, hex] of known.colorNameToHex) {
			if(this.colorNamesExt.has(name)) {
				this.colorNameToHexExt.set(name, hex);
			}
		}

		this.colorTemperatureNamesExt = new Set();
		for(const option of colorTemperatureNameOptions) {
			this.colorTemperatureNamesExt.add(option.value);
		}

		this.colorTemperatureNameToKelvinExt = new Map();
		for(const [name, kelvin] of known.colorTemperatureNameToKelvin) {
			if(this.colorTemperatureNamesExt.has(name)) {
				this.colorTemperatureNameToKelvinExt.set(name, kelvin);
			}
		}
	}

	// short circuit default initializers
	prepare(callback) { callback && callback();	}
	initDeviceState(callback) { callback && callback(); } 
	initWakewords(callback) { callback && callback(); }
	initBluetoothState(callback) { callback && callback(); }
	initNotifications(callback) { callback && callback(); }

	// overrides
	find(id) {
		let found;
		if(typeof id === 'object') return id;
		if(typeof id !== 'string') return null;
		if(found = this.deviceByIdExt.get(id)) return found;
		if(found = this.deviceByNameExt.get(stringForCompare(id))) return found;
	}

	async initAccountExt() {
		return this.getAccountPromise().then(response => {
			for(const account of response) {
				if(account.commsId) {
					this.commsId = account.commsId;
					break;
				}
			}
		});
	}

	_deviceChange() {
		this.deviceByNameExt = new Map(Array.from(this.deviceByIdExt.values(), o => [stringForCompare(o.accountName), o]));
		this.serialNumbers = {};
		for(const device of this.deviceByIdExt.values()) {
			this.serialNumbers[device.serialNumber] = device;
		}
		this.emit('change-device');
	}
	async initDevicesExt() {
		return this.getDevicesPromise().then(response => {
			this.deviceByIdExt = new Map(response.devices.map(o => [o.serialNumber, o]));
			this._deviceChange();
		});
	}

	_notificationChange() {
		this.notificationByNameExt = new Map(Array.from(this.notificationByIdExt.values())
			.filter(o => o.type === 'Timer' ? o.timerLabel : o.reminderLabel)
			.map(o => [stringForCompare(o.type === 'Timer' ? o.timerLabel : o.reminderLabel), o]));

		this.emit('change-notification');
	}
	async initNotificationsExt() {
		return this.getNotificationsPromise().then(response => {
			if(!tools.matches(response, { notifications: [{ id: '' }] })) throw new Error(`unexpected notifications response: "${JSON.stringify(response)}"`);
			this.notificationByIdExt = new Map(response.notifications.map(o => [o.notificationIndex, o]));
			this._notificationChange();
		});
	}

	async updateNotificationsExt(type, id, version) {
		this.notificationUpdatesExt.push({type: type, id: id, version: version });
		if(DEBUG_THIS) tools.log(`notification update added: ${type} ${id} @ ${version}`);

		if(this.notificationUpdatesRunning)	return tools.log(`notification update already running...`);
		this.notificationUpdatesRunning = true;		
		if(DEBUG_THIS) tools.log(`notification update starting...`);

		const applyAll = async () => {
			let update;
			while(update = this.notificationUpdatesExt.pop()) {
				const {type, id, version} = update;
				if(DEBUG_THIS) tools.log(`notification update popped: ${type} ${id} @ ${version}`);
		
				if(type === 'DELETE') {
					const notification = this.notificationByIdExt.get(id);
					if(!notification) {
						tools.log(`notification update apply but already gone: ${type} ${id} @ ${version}`);
						continue;
					}
					this.notificationByIdExt.delete(id);
					if(DEBUG_THIS) tools.log(`notification update apply: ${type} ${id} @ ${version} (previous version: ${notification && notification.version})`)
					this._notificationChange();
				}
				else {
					const notification = this.notificationByIdExt.get(id);
					if(notification && Number(notification.version) >= Number(version)) {
						 tools.log(`notification update apply but we are already up to date: ${type} ${id} @ ${version}`);
						 continue;
					}
					if(DEBUG_THIS) tools.log(`notification update apply: ${type} ${id} @ ${version} (previous version: ${notification && notification.version})`);
					await this.initNotificationsExt();
				}
			}
		}

		await applyAll().then(() => {
			this.notificationUpdatesRunning = false;
			tools.log(`notification update ended successfully...`);
		}).catch(error => {
			this.notificationUpdatesRunning = false;
			tools.log(`notification update ended erronously...`);
			error.message = `failed to update notifications: ${error.message}`;
			this.warnCallback(error);
		})
	}

	async refreshExt() {
		this._options.cookie = this.cookieData;
		delete this._options.csrf;
		return this.initExt(this._options);
	}

	resetExt() {
		this.stop();
		
		if (this.alexaCookie) {
			this.alexaCookie.stopProxyServer();
		}
		if (this.alexaWsMqtt) {
			this.alexaWsMqtt.removeAllListeners();
		}

		this.removeAllListeners();	
	}

	async httpsGetPromise(noCheck, path, flags) {
        if (typeof noCheck !== 'boolean') {
            flags = path;
            path = noCheck;
            noCheck = false;
        }

		return new Promise((resolve, reject) => {
			const callback = (err, val) => err ? reject(err) : resolve(val);
			this.httpsGet(noCheck, path, callback, flags);
		});
	}

	// overrides
	generateCookie(email, password, callback) {
        if (!this.alexaCookie) this.alexaCookie = requireUncached('alexa-cookie2');
        this.alexaCookie.generateAlexaCookie(email, password, this._options, callback);
    }

	// overrides
    refreshCookie(callback) {
        if (!this.alexaCookie) this.alexaCookie = requireUncached('alexa-cookie2');
        this.alexaCookie.refreshAlexaCookie(this._options, callback);
	}

	async sendSequenceNodeExt(sequenceNode) {
		const wrapperNode = {
			'@type': 'com.amazon.alexa.behaviors.model.Sequence',
			startNode: sequenceNode
		}

		const requestData = {
			behaviorId: 'PREVIEW',
			sequenceJson: JSON.stringify(wrapperNode),
			status: 'ENABLED',
		}

		//tools.log({sequenceNode: sequenceNode});

		return this.httpsGetPromise(`/api/behaviors/preview`, { 
			method: 'POST', 
			data: JSON.stringify(requestData)
		}).catch(error => {
			if(error.message === 'no body') {
				return null; // false positive
			}
			throw error;
		});
	}

	findSmarthomeEntityExt(id) {
		if(typeof id !== 'string' || !this.smarthomeSimplifiedByEntityIdExt) return undefined;

		// by entityId
		let entity = this.smarthomeSimplifiedByEntityIdExt.get(id);
		if(entity) return entity;	
	
		// by applianceId
		for(const entity of this.smarthomeSimplifiedByEntityIdExt.values()) {
			if(entity.applianceId === id) return entity;
		}

		// by name
		const lowercase = id.toLowerCase();
		for(const entity of this.smarthomeSimplifiedByEntityIdExt.values()) {
			if(entity.name.toLowerCase() === lowercase) return entity;
		}

		return undefined;
	}

	async findSmarthomeEntityExtAsync(id) {
		const entity = findSmarthomeEntityExt(id);
		if(!entity) throw new Error(`smarthome entity not found: "${id}"`);
		return entity;
	}

	findSmarthomeColorNameExt(arg) {
		if(typeof arg !== 'string') return undefined;

		if(!arg.startsWith('#')) {
			if(!this.colorNamesExt.has(arg)) {
				return arg;
			}

			for(const name of this.colorNamesExt) {
				if(tools.alnumEqual(name, arg)) {
					return name;
				}
			}

			return undefined;
		}

		const target = convert.hex2lab(arg);
		let closestDelta = Infinity;
		let closestName = undefined;

		for(const [name, hex] of this.colorNameToHexExt) {
			const lab = convert.hex2lab(hex);
			const delta = deltaE(target, lab);
			if(delta < closestDelta) {
				closestDelta = delta;
				closestName = name;
			}
		}

		return closestName;
	}

	findSmarthomeColorTemperatureNameExt(arg) {
		const type = typeof arg;
		if(type !== 'string' && type !== 'number') return undefined;

		if(type === 'string' && !arg.startsWith('#')) {
			if(!this.colorTemperatureNamesExt.has(arg)) {
				return arg;
			}

			for(const name of this.colorTemperatureNamesExt) {
				if(tools.alnumEqual(name, arg)) {
					return name;
				}
			}

			return undefined;
		}
	
		const number = Number(arg);
		const target = Number.isNaN(number) ? convert.hex2lab(arg) : convert.tmp2lab(number)
		let closestDelta = Infinity;
		let closestName = undefined;

		for(const [name, kelvin] of this.colorTemperatureNameToKelvinExt) {
			const lab = convert.tmp2lab(kelvin);
			const delta = deltaE(target, lab);
			if(delta < closestDelta) {
				closestDelta = delta;
				closestName = name;
			}
		}

		return closestName;
	}

	// requests like ['Lamp 1', '1234-DEAD-BEEF-5678' }]
	async querySmarthomeDevicesExt(requests) {
		const entities = requests.map(request => this.findSmarthomeEntityExt(request.entity));
		const nativeRequests = entities.filter(e => e).map(entity => ({
			entityType: entity.type,
			entityId: entity.applianceId,
		}));

		const response = await querySmarthomeDevicesRawExt(nativeRequests);
		if(!tools.matches(response, {deviceStates: [{}], errors: [{}]}, 2)) {
			throw new Error('unexpected response layout');
		}

		const states = response.deviceStates;
		const errors = response.errors;

		return [states, errors];
	}

	async querySmarthomeDevicesExt(stateRequests) {
		/*
		'stateRequests': [
			{
				'entityId': 'AAA_SonarCloudService_00:17:88:01:04:1D:4C:A0',
				'entityType': 'APPLIANCE'
			}
		]
		*/

		const flags = {
			method: 'POST',
			data: JSON.stringify({
				'stateRequests': stateRequests
			})
		}

		console.log(util.inspect(flags, false, 10, true));
		return this.httpsGetPromise('/api/phoenix/state', flags);
	}

	async executeSmarthomeDeviceActionExt(controlRequests) {
		/*
        {
            'controlRequests': [
                {
                    'entityId': 'bbd72582-4b16-4d1f-ab1b-28a9826b6799',
                    'entityType':'APPLIANCE',
                    'parameters':{
                        'action':'turnOn'
                    }
                }
            ]
		}
		*/

		const flags = {
			method: 'PUT',
			data: JSON.stringify({
				'controlRequests': controlRequests
			})
		}

		console.log(util.inspect(flags, false, 10, true));
		return this.httpsGetPromise('/api/phoenix/state', flags);
	}

	async deleteSmarthomeDeviceExt(id) {
		return new Promise((resolve, reject) => {
			const entity = this.findSmarthomeEntityExt(id);
			if(!entity || entity.type !== 'APPLIANCE') throw new Error(`smarthome device not found: "${id}"`);
			this.deleteSmarthomeDevice(entity.applianceId, (err, val) => {
				err && err.message !== 'no body' ? reject(err) : resolve(val);
			});
		});
	}

	async deleteSmarthomeGroupExt(id) {
		return new Promise((resolve, reject) => {
			const entity = this.findSmarthomeEntityExt(id);
			if(!entity || entity.type !== 'GROUP') throw new Error(`smarthome group not found: "${id}"`);
			this.deleteSmarthomeGroup(entity.groupId, (err, val) => {
				err && err.message !== 'no body' ? reject(err) : resolve(val);
			});
		});
	}

	async deleteAllSmarthomeDevicesExt() {
		return new Promise((resolve, reject) => {
			this.deleteAllSmarthomeDevices((err, val) => {
				err && err.message !== 'no body' ? reject(err) : resolve(val);
			});
		});
	}

	// type like "TASK" or "SHOPPING_ITEM"
	async getListExt(type = 'TASK', size = 100) {
		if(!['TASK', 'SHOPPING_ITEM'].includes(type)) throw new Error(`invalid list type: "${type}"`);
		return this.httpsGetPromise(`/api/todos?type=${type}&size=${size}&_=%t`);
	}

	// type like "TASK" or "SHOPPING_ITEM"
	async addListItemExt(type, text) {
		if(!['TASK', 'SHOPPING_ITEM'].includes(type)) throw new Error(`invalid list type: "${type}"`);

		const request = {
			type: type,
			text: text,
			createdDate: new Date().getTime(),
			completed: false,
			deleted: false,
		}

		this.httpsGetPromise(`/api/todos`, {
			method: 'POST',
			data: JSON.stringify(request),
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
			}
		})
	}

	findNotificationExt(id) {
		let found;
		if(found = this.notificationByIdExt.get(id)) return found;
		if(found = this.notificationByNameExt.get(stringForCompare(id))) return found;
	}

	// type like "Reminder" or "Alarm" or "Timer"
	// status like "ON" or "OFF" or "PAUSED"
	createNotificationObjectExt(serialOrName, type, label, time, status = 'ON', sound) {
		const device = this.find(serialOrName);
		if(!device) throw new Error('device not found');
		if(!['Reminder', 'Alarm', 'Timer'].includes(type)) throw new Error(`invalid notification type: "${type}"`);
		if(!['ON', 'OFF', 'PAUSED'].includes(status)) throw new Error(`invalid notification status: "${status}"`);
		const timer = type === 'Timer';
		time = Number(timer ? parseDuration(time) : new Date(time).getTime());
		if(Number.isNaN(time)) throw new Error('invalid date/time');
		const now = Date.now();
		const [Y,M,D,h,m,s,u] = timer ? [] : dateToStringPieces(new Date(time));

		return {
			"alarmTime": timer ? 0 : time,
			"createdDate": now,
			"deferredAtTime": null,
			"deviceSerialNumber": device.serialNumber,
			"deviceType": device.deviceType,
			"extensibleAttribute": null,
			"geoLocationTriggerData": null,
			"id": `${device.deviceType}-${device.serialNumber}-${type.toLowerCase()}-${now}`,
			"lastUpdatedDate": now,
			"musicAlarmId": null,
			"musicEntity": null,
			"notificationIndex": `${type.toLowerCase()}-${now}`,
			"originalDate": timer ? null : `${Y}-${M}-${D}`,
			"originalTime": timer ? null : `${h}:${m}:${s}.${u}`,
			"personProfile": null,
			"provider": null,
			"rRuleData": type !== 'Reminder' ? null : {
				"byMonthDays": null,
				"byWeekDays": null,
				"flexibleRecurringPatternType": null,
				"frequency": null,
				"intervals": null,
				"nextTriggerTimes": null,
				"notificationTimes": null,
				"recurEndDate": null,
				"recurEndTime": null,
				"recurStartDate": null,
				"recurStartTime": null,
				"recurrenceRules": null
			},
			"recurringPattern": null,
			"remainingTime": timer ? time : 0,
			"reminderLabel": timer ? null : label,
			"skillInfo": null,
			"snoozedToTime": null,
			"sound": sound ? sound : {
				"displayName": "Simple Alarm",
				"folder": null,
				"id": "system_alerts_melodic_01",
				"providerId": "ECHO",
				"sampleUrl": "https://s3.amazonaws.com/deeappservice.prod.notificationtones/system_alerts_melodic_01.mp3"
			},
			"status": status,
			"targetPersonProfiles": null,
			"timeZoneId": null,
			"timerLabel": timer ? label : null,
			"triggerTime": 0,
			"type": type,
			"version": '1'
		}
	}

	changeNotificationObjectExt(notification, label, time, status, sound) {
		if(status && !['ON', 'OFF', 'PAUSED'].includes(status)) throw new Error(`invalid notification status: "${status}"`);
		
		const timer = notification.type === 'Timer';
		if(time) {
			time = Number(timer ? parseDuration(time) : new Date(time).getTime());
			if(Number.isNaN(time)) throw new Error('invalid date/time');
		}
		
		if(timer) {
			if(status !== notification.status) notification.triggerTime = Date.now();
			if(label) notification.timerLabel = label;
			//if(time) notification.remainingTime = time;
			notification.remainingTime = time || null;
		}
		else {
			const [Y,M,D,h,m,s,u] = dateToStringPieces(new Date(time));
			notification.reminderIndex = null;
			notification.isSaveInFlight = true;
			notification.isRecurring = !!notification.recurringPattern; // ?? i guess....
			if(status) notification.status = status;
			if(label) notification.reminderLabel = label;
			if(time) {
				notification.alarmTime = time;
				notification.originalDate = `${Y}-${M}-${D}`;
				notification.originalTime = `${h}:${m}:${s}.${u}`;
			}
		}

		if(status) notification.status = status;
		if(sound) notification.sound = sound;
	}

	async createNotificationExt(serialOrName, type, label, time, status, sound) {
		const notification = this.createNotificationObjectExt(serialOrName, type, label, time, status, sound);

		return this.httpsGetPromise(`/api/notifications/createReminder`, {
			data: JSON.stringify(notification), 
			method: 'PUT',
		}).then(notification => {
			this.notificationByIdExt.set(notification.notificationIndex, notification);
			this._notificationChange();
			return notification;
		});
	}

	async changeNotificationExt(notification, label, time, status, sound) {
		const found = typeof notification === 'object' ? notification : this.findNotificationExt(notification);
		if(!found) throw new Error(`notification not found: "${notification}"`);
		const changed = tools.clone(found);
		this.changeNotificationObjectExt(changed, label, time, status, sound);

		return this.httpsGetPromise(`/api/notifications/${changed.id}`, {
			data: JSON.stringify(changed), 
			method: 'PUT',
		}).then(notification => {
			this.notificationByIdExt.set(notification.notificationIndex, notification);
			this._notificationChange();
			return notification;
		});
	}

	async deleteNotificationExt(notification) {
		const found = typeof notification === 'object' ? notification : this.findNotificationExt(notification);
		if(!found) throw new Error(`notification not found: "${notification}"`);

        return this.httpsGetPromise(`/api/notifications/${found.id}`, {
            data: JSON.stringify (found),
            method: 'DELETE',
		}).catch(error => {
			if(error.message === 'no body') return;
			throw error;
		}).then(response => {
			this.updateNotificationsExt('DELETE', found.notificationIndex, found.version);
			return response;
		});
	}

	async getSoundsExt(device) {
		const found = this.find(device);
		if(!found) throw new Error(`device not found: "${device}"`);
		const response = await this.httpsGetPromise(`/api/notification/migration/sounds?deviceSerialNumber=${found.serialNumber}&deviceType=${found.deviceType}&softwareVersion=${found.softwareVersion}&_=%t`);
		ensureMatch(response, { notificationSounds: [{}] });
		return response.notificationSounds;
	}

	async getDefaultSound(device, notificationType = 'Alarm') {
		const found = this.find(device);
		if(!found) throw new Error(`device not found: "${device}"`);

		return this.httpsGetPromise(`/api/notification/migration/default-sound?deviceSerialNumber=${found.serialNumber}&deviceType=${found.deviceType}&softwareVersion=${found.softwareVersion}&notificationType=${notificationType.toUpperCase()}&_=%t`)
	}

	async getDeviceNotificationStatesExt() {
		const response = await this.httpsGetPromise(`/api/device-notification-state&_=%t`);
		ensureMatch(response, { deviceNotificationStates: [{}] });
		return response.deviceNotificationStates;
	}

	async findAsync(device) {
		const found = this.find(device);
		if(!found) throw new Error(`device not found: "${device}"`);
		return found;
	}
	
	async checkAuthenticationExt() {
		return new Promise((resolve, reject) => {
			this.checkAuthentication((authenticated, error) => {
				error ? reject(error) : resolve(authenticated);
			});
		});
	}

	async renameDeviceExt(device, name) {
		const found = await this.findAsync(device);
		return this.renameDevicePromise(found, name).then(response => {
			if(!tools.matches(response, { accountName: '', serialNumber: ''})) return response;
			found.accountName = response.accountName;
			//this.deviceByIdExt.set(response.serialNumber, response);
			this._deviceChange();
			return found;
		});
	}

	async deleteDeviceExt(device) {
		const found = await this.findAsync(device);
		return this.deleteDevicePromise(found).then(response => {
			this.deviceByIdExt.delete(found.serialNumber);
			this._deviceChange();
			return response;
		}).catch(error => {
			if(error.message === 'no body') return;
			throw error;
		});
	}
}

module.exports = AlexaRemoteExt;