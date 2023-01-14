/**
 * Based on gerth2's (https://github.com/gerth2) implementation in pure js
 *
 * See https://github.com/wpilibsuite/allwpilib/blob/main/ntcore/doc/networktables4.adoc
 * for the full spec.
 */

import { encode, decode, decodeMulti, decodeMultiStream } from '@msgpack/msgpack';
import { Method } from './types';
import { isValidAnnounceParams, isValidUnAnnounceParams, typestrIdxLookup } from './utils';

/**
 * JS Definition of the topic type strings
 */
const enum Type {
	BOOL = 'boolean',
	FLOAT_64 = 'double',
	INT = 'int',
	FLOAT_32 = 'float',
	STR = 'string',
	JSON = 'json',
	BIN_RAW = 'raw',
	BIN_RPC = 'rpc',
	BIN_MSGPACK = 'msgpack',
	BIN_PROTOBUF = 'protobuf',
	BOOL_ARR = 'boolean[]',
	FLOAT_64_ARR = 'double[]',
	INT_ARR = 'int[]',
	FLOAT_32_ARR = 'float[]',
	STR_ARR = 'string[]',
}

/**
 * Class to describe a client's subscription to topics
 */
export class Subscription {
	topics = new Set();
	options = {
		periodicRate_s: 0.1,
		all: false,
		topicsonly: false,
		prefix: true, //nonstandard default
	};
	uid = -1;

	toSubscribeObj() {
		return {
			topics: Array.from(this.topics),
			options: this.options,
			subuid: this.uid,
		};
	}

	toUnSubscribeObj() {
		return {
			subuid: this.uid,
		};
	}
}

/**
 * Class to describe the options associated with a client's subscription to topics
 */
export type SubscriptionOptions = {
	periodicRate_s: number;
	all: boolean;
	topicsonly: boolean;
	prefix: boolean; //nonstandard default
};

/**
 * Class to describe a topic that the client and server both know about
 */
export class Topic {
	name = '';
	type: keyof typeof typestrIdxLookup = 'NT4_TYPESTR';
	id = 0;
	pubuid = 0;
	properties: Record<string, any> = {}; //Properties are free-form, might have anything in them

	toPublishObj() {
		return {
			name: this.name,
			type: this.type,
			pubuid: this.pubuid,
		};
	}

	toUnPublishObj() {
		return {
			name: this.name,
			pubuid: this.pubuid,
		};
	}

	toPropertiesObj() {
		return {
			name: this.name,
			update: this.properties,
		};
	}

	getTypeIdx() {
		return typestrIdxLookup[this.type];
	}

	getPropertiesString() {
		let retStr = '{';
		for (const key in this.properties) {
			retStr += key + ':' + this.properties[key] + ', ';
		}
		retStr += '}';
		return retStr;
	}
}

export class Client {
	onTopicAnnounce: (topic: Topic) => void;
	onTopicUnAnnounce: (topic: Topic) => void;
	onNewTopicData: (topic: Topic, timestamp: number, data: any) => void;
	onConnect: () => void;
	onDisconnect: () => void;
	subscriptions: Map<number, Subscription>;
	subscriptionUidCounter: number;
	publishUidCounter: number;
	clientPublishedTopics: Map<string, Topic>;
	announcedTopics: Map<number, Topic>;
	timeSyncBgEvent: number;
	serverBaseAddr: string;
	clientIdx: number;
	serverAddr: string;
	serverConnectionActive: boolean;
	serverTimeOffsetMicros: number;
	ws: WebSocket | null = null;

	/**
	 * Main client class. User code should instantiate one of these.
	 * Client will immediately start to try to connect to the server on instantiation
	 * and continue to reconnect in the background if disconnected.
	 * As long as the server is connected, time synchronization will occur in the background.
	 */
	constructor({
		serverAddr,
		onTopicAnnounce,
		onTopicUnAnnounce,
		onNewTopicData,
		onConnect,
		onDisconnect,
	}: {
		serverAddr: string;
		onTopicAnnounce: (topic: Topic) => void;
		onTopicUnAnnounce: (topic: Topic) => void;
		onNewTopicData: (topic: Topic, timestamp: number, data: any) => void;
		onConnect: () => void;
		onDisconnect: () => void;
	}) {
		this.onTopicAnnounce = onTopicAnnounce;
		this.onTopicUnAnnounce = onTopicUnAnnounce;
		this.onNewTopicData = onNewTopicData;
		this.onConnect = onConnect;
		this.onDisconnect = onDisconnect;

		this.subscriptions = new Map();
		this.subscriptionUidCounter = 0;
		this.publishUidCounter = 0;

		this.clientPublishedTopics = new Map();
		this.announcedTopics = new Map();

		this.timeSyncBgEvent = setInterval(this.#ws_sendTimestamp.bind(this), 5000);

		// WS Connection State (with defaults)
		this.serverBaseAddr = serverAddr;
		this.clientIdx = 0;
		this.serverAddr = '';
		this.serverConnectionActive = false;
		this.serverTimeOffsetMicros = 0;

		//Trigger the websocket to connect automatically
		this.#ws_connect();
	}

	//////////////////////////////////////////////////////////////
	// PUBLIC API

	/**
	 * Add a new subscription which requests announcement of topics, but no data
	 * Generally, this must be called first before the server will announce any topics.
	 * @returns a NT4_Subscription object describing the subscription
	 */
	subscribeTopicNames(topicPatterns: string[]) {
		const newSub = new Subscription();
		newSub.uid = this.#getNewSubUID();
		newSub.options.topicsonly = true;
		newSub.options.periodicRate_s = 1.0;
		newSub.topics = new Set(topicPatterns);

		this.subscriptions.set(newSub.uid, newSub);
		if (this.serverConnectionActive) {
			this.#ws_subscribe(newSub);
		}
		return newSub;
	}

	/**
	 * Subscribe to topics, requesting the server send value updates periodically.
	 * This means the server may skip sending some value updates.
	 * @returns a NT4_Subscription object describing the subscription
	 */
	subscribePeriodic(topicPatterns: string[], period: number) {
		const newSub = new Subscription();
		newSub.uid = this.#getNewSubUID();
		newSub.options.periodicRate_s = period;
		newSub.topics = new Set(topicPatterns);

		this.subscriptions.set(newSub.uid, newSub);
		if (this.serverConnectionActive) {
			this.#ws_subscribe(newSub);
		}
		return newSub;
	}

	/**
	 * Subscribe to topics, requesting the server send all value updates.
	 * @returns a NT4_Subscription object describing the subscription
	 */
	subscribeAllSamples(topicPatterns: string[]) {
		const newSub = new Subscription();
		newSub.uid = this.#getNewSubUID();
		newSub.topics = new Set(topicPatterns);
		newSub.options.all = true;

		this.subscriptions.set(newSub.uid, newSub);
		if (this.serverConnectionActive) {
			this.#ws_subscribe(newSub);
		}
		return newSub;
	}

	/**
	 * Request the server stop sending value updates and topic announcements
	 */
	unsubscribe(sub: Subscription) {
		this.subscriptions.delete(sub.uid);
		if (this.serverConnectionActive) {
			this.#ws_unsubscribe(sub);
		}
	}

	/**
	 * Unsubscribe from all current subscriptions
	 */
	clearAllSubscriptions() {
		for (const sub of this.subscriptions.values()) {
			this.unsubscribe(sub);
		}
	}

	/**
	 * Set the properties of a particular topic
	 */
	setProperties(topic: Topic, isPersistent: boolean, isRetained: boolean) {
		topic.properties.persistent = isPersistent;
		topic.properties.retained = isRetained;
		if (this.serverConnectionActive) {
			this.#ws_setProperties(topic);
		}
	}

	/**
	 * Publish a new topic from this client
	 * @returns
	 */
	publishNewTopic(name: string, type: keyof typeof typestrIdxLookup) {
		const newTopic = new Topic();
		newTopic.name = name;
		newTopic.type = type;
		this.publishTopic(newTopic);
		return newTopic;
	}

	/**
	 * Publish a new topic from this client
	 * @returns
	 */
	publishTopic(topic: Topic) {
		topic.pubuid = this.#getNewPubUID();
		this.clientPublishedTopics.set(topic.name, topic);
		if (this.serverConnectionActive) {
			this.#ws_publish(topic);
		}
	}

	/**
	 * Un-Publish a previously-published topic from this client
	 * @returns
	 */
	unPublishTopic(oldTopic: Topic) {
		this.clientPublishedTopics.delete(oldTopic.name);
		if (this.serverConnectionActive) {
			this.#ws_unPublish(oldTopic);
		}
	}

	/**
	 * Send some new value to the server
	 * Timestamp is whatever the current time is.
	 */
	addSample(topic: Topic, value: any): void;
	addSample(topic: Topic, timestamp: number, value: any): void;

	/**
	 * Send some new value to the server
	 * Timestamp is whatever the current time is.
	 */
	addSample(topic: Topic, timestampOrValue: unknown, value?: any) {
		timestampOrValue;
		const sourceData = value
			? [topic.pubuid, timestampOrValue, topic.getTypeIdx(), value]
			: [topic.pubuid, this.getServerTimeMicros(), topic.getTypeIdx(), timestampOrValue];
		const txData = encode(sourceData);

		this.#ws_sendBinary(txData);
	}

	/**
	 * Gets the server time. This is equal to the client current time, offset
	 * by the most recent results from running Cristian’s Algorithm with the server
	 * to synchronize timebases.
	 * @returns The current time on the server, in microseconds
	 */
	getServerTimeMicros() {
		return this.getClientTimeMicros() + this.serverTimeOffsetMicros;
	}

	//////////////////////////////////////////////////////////////
	// Server/Client Time Sync Handling

	getClientTimeMicros() {
		return Math.round(performance.now() * 1000.0);
	}

	#ws_sendTimestamp() {
		const timeTopic = this.announcedTopics.get(-1);
		if (timeTopic) {
			const timeToSend = this.getClientTimeMicros();
			this.addSample(timeTopic, 0, timeToSend);
		}
	}

	#ws_handleReceiveTimestamp(serverTimestamp: number, clientTimestamp: number) {
		const rxTime = this.getClientTimeMicros();

		//Recalculate server/client offset based on round trip time
		const rtt = rxTime - clientTimestamp;
		const serverTimeAtRx = serverTimestamp - rtt / 2.0;
		this.serverTimeOffsetMicros = serverTimeAtRx - rxTime;
	}

	//////////////////////////////////////////////////////////////
	// Websocket Message Send Handlers

	#ws_subscribe(sub: Subscription) {
		this.#ws_sendJSON('subscribe', sub.toSubscribeObj());
	}

	#ws_unsubscribe(sub: Subscription) {
		this.#ws_sendJSON('unsubscribe', sub.toUnSubscribeObj());
	}

	#ws_publish(topic: Topic) {
		this.#ws_sendJSON('publish', topic.toPublishObj());
	}

	#ws_unPublish(topic: Topic) {
		this.#ws_sendJSON('unpublish', topic.toUnPublishObj());
	}

	#ws_setProperties(topic: Topic) {
		this.#ws_sendJSON('setproperties', topic.toPropertiesObj());
	}

	#ws_sendJSON(method: Method, params: any) {
		//Sends a single json message
		if (this.ws?.readyState === WebSocket.OPEN) {
			const txObj = [
				{
					method: method,
					params: params,
				},
			];
			const txJSON = JSON.stringify(txObj);

			console.log('[NT4] Client Says: ' + txJSON);

			this.ws.send(txJSON);
		}
	}

	#ws_sendBinary(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(data);
		}
	}

	//////////////////////////////////////////////////////////////
	// Websocket connection Maintenance

	#ws_onOpen() {
		// Add default time topic
		const timeTopic = new Topic();
		timeTopic.name = 'Time';
		timeTopic.id = -1;
		timeTopic.pubuid = -1;
		timeTopic.type = Type.INT;
		this.announcedTopics.set(timeTopic.id, timeTopic);

		// Set the flag allowing general server communication
		this.serverConnectionActive = true;

		//Publish any existing topics
		for (const topic of this.clientPublishedTopics.values()) {
			this.#ws_publish(topic);
			this.#ws_setProperties(topic);
		}

		//Subscribe to existing subscriptions
		for (const sub of this.subscriptions.values()) {
			this.#ws_subscribe(sub);
		}

		// User connection-opened hook
		this.onConnect();
	}

	#ws_onClose(e: WebSocketEventMap['close']) {
		//Clear flags to stop server communication
		this.ws = null;
		this.serverConnectionActive = false;

		// User connection-closed hook
		this.onDisconnect();

		//Clear out any local cache of server state
		this.announcedTopics.clear();

		console.log('[NT4] Socket is closed. Reconnect will be attempted in 0.5 second.', e.reason);
		setTimeout(this.#ws_connect.bind(this), 500);

		if (!e.wasClean) {
			console.error('Socket encountered error!');
		}
	}

	#ws_onError(e: WebSocketEventMap['error']) {
		console.log('[NT4] Websocket error - ' + e.toString());
		this.ws?.close();
	}

	async #ws_onMessage(e: WebSocketEventMap['message']) {
		if (typeof e.data === 'string') {
			console.log('[NT4] Server Says: ' + e.data);
			//JSON Message
			const rxArray = JSON.parse(e.data);

			rxArray.forEach((msg: Record<string, unknown>) => {
				//Validate proper format of message
				if (typeof msg !== 'object') {
					console.log(
						'[NT4] Ignoring text message, JSON parsing did not produce an object.'
					);
					return;
				}

				if (!('method' in msg) || !('params' in msg)) {
					console.log(
						'[NT4] Ignoring text message, JSON parsing did not find all required fields.'
					);
					return;
				}

				const method = msg['method'];
				const params = msg['params'];

				if (typeof method !== 'string') {
					console.log(
						'[NT4] Ignoring text message, JSON parsing found "method", but it wasn\'t a string.'
					);
					return;
				}

				if (typeof params !== 'object') {
					console.log(
						'[NT4] Ignoring text message, JSON parsing found "params", but it wasn\'t an object.'
					);
					return;
				}

				// Message validates reasonably, switch based on supported methods
				if (method === 'announce') {
					if (!isValidAnnounceParams(params)) {
						return console.warn('Server sent an invalid Announce message:', msg);
					}

					//Check to see if we already knew about this topic. If not, make a new object.

					let newTopic: Topic | null = null;
					for (const topic of this.clientPublishedTopics.values()) {
						if (params.name === topic.name) {
							newTopic = topic; //Existing topic, use it.
						}
					}

					// Did not know about the topic. Make a new one.
					if (newTopic === null) {
						newTopic = new Topic();
					}

					newTopic.name = params.name;
					newTopic.id = params.id;

					//Strategy - if server sends a pubid use it
					// otherwise, preserve whatever we had?
					//TODO - ask peter about this. It smells wrong.
					if (params.pubuid != null) {
						newTopic.pubuid = params.pubuid;
					}

					newTopic.type = params.type;
					newTopic.properties = params.properties ?? {};
					this.announcedTopics.set(newTopic.id, newTopic);
					this.onTopicAnnounce(newTopic);
				} else if (method === 'unannounce') {
					if (!isValidUnAnnounceParams(params)) {
						return console.warn('Server send an invalid UnAnnounce message:', msg);
					}

					const removedTopic = this.announcedTopics.get(params.id);
					if (!removedTopic) {
						console.log(
							'[NT4] Ignorining unannounce, topic was not previously announced.'
						);
						return;
					}
					this.announcedTopics.delete(removedTopic.id);
					this.onTopicUnAnnounce(removedTopic);
				} else if (method === 'properties') {
					//TODO support property changes
					console.error('Client does not currently support `properties` method.');
				} else {
					console.log('[NT4] Ignoring text message - unknown method ' + method);
					return;
				}
			}, this);
		} else {
			//MSGPack
			for await (const unpackedData of decodeMultiStream(e.data)) {
				if (!Array.isArray(unpackedData) || unpackedData.length < 4) {
					return console.warn('Server sent an invalid value:', unpackedData);
				}

				//For every value update...
				const topicID = unpackedData[0];
				const timestamp_us = unpackedData[1];
				const typeIdx = unpackedData[2];
				const value = unpackedData[3];

				if (topicID >= 0) {
					const topic = this.announcedTopics.get(topicID);
					if (!topic) {
						return console.warn(
							`Server sent a topic id '${topicID}' that doesn't exist.`
						);
					}
					this.onNewTopicData(topic, timestamp_us, value);
				} else if (topicID === -1) {
					this.#ws_handleReceiveTimestamp(timestamp_us, value);
				} else {
					console.log(
						'[NT4] Ignoring binary data - invalid topic id ' + topicID.toString()
					);
				}
			}
		}
	}

	#ws_connect() {
		this.clientIdx = Math.floor(Math.random() * 99999999); //Not great, but using it for now

		const port = 5810; //fallback - unsecured
		const prefix = 'ws://';

		this.serverAddr = `${prefix}${this.serverBaseAddr}:${port}/nt/JSClient_${this.clientIdx}`;

		this.ws = new WebSocket(this.serverAddr, 'networktables.first.wpi.edu');
		this.ws.binaryType = 'arraybuffer';
		this.ws.onopen = this.#ws_onOpen.bind(this);
		this.ws.onmessage = this.#ws_onMessage.bind(this);
		this.ws.onclose = this.#ws_onClose.bind(this);
		this.ws.onerror = this.#ws_onError.bind(this);

		console.log('[NT4] Connected with idx ' + this.clientIdx.toString());
	}

	//////////////////////////////////////////////////////////////
	// General utilties
	//////////////////////////////////////////////////////////////

	#getNewSubUID() {
		this.subscriptionUidCounter++;
		return this.subscriptionUidCounter + this.clientIdx;
	}

	#getNewPubUID() {
		this.publishUidCounter++;
		return this.publishUidCounter + this.clientIdx;
	}
}
