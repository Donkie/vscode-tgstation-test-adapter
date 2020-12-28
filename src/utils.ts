import { promises as fsp } from 'fs';
import * as path from 'path';

export async function exists(fileordir: string) {
	try {
		await fsp.access(fileordir);
		return true;
	} catch (err) {
		return false;
	}
}

export async function mkDir(directory: string) {
	let direxists = await exists(directory);
	if (!direxists) {
		await fsp.mkdir(directory);
	}
}

export async function rmDir(directory: string) {
	let dirExists = await exists(directory);
	if (!dirExists) {
		return;
	}
	let files = await fsp.readdir(directory);
	await Promise.all(
		files.map(file => fsp.unlink(path.join(directory, file)))
	);
	try {
		await fsp.unlink(directory);
	} catch { }
}
