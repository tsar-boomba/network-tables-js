/**
 * Lookup from type string to type integer
 */
export const typestrIdxLookup = {
	NT4_TYPESTR: 0,
	double: 1,
	int: 2,
	float: 3,
	string: 4,
	json: 4,
	raw: 5,
	rpc: 5,
	msgpack: 5,
	protobuf: 5,
	'boolean[]': 16,
	'double[]': 17,
	'int[]': 18,
	'float[]': 19,
	'string[]': 20,
} as const;

export const isValidAnnounceParams = (
	v: any
): v is {
	name: string;
	type: keyof typeof typestrIdxLookup;
	id: number;
	pubuid?: number;
	properties?: Record<string, any>;
} => {
	return !!v && typeof v.name === 'string' && typeof v.type === 'string' && typeof v.id === 'number';
};

export const isValidUnAnnounceParams = (
	v: any
): v is {
	name: string;
	id: number;
} => {
	return (
		!!v && typeof v.name === 'string' && typeof v.id === 'number'
	);
};
