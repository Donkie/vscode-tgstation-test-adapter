import { promises as fsp } from 'fs';
import * as path from 'path';
import * as fs from 'fs';
import { EventEmitter } from 'vscode';
import { CancelError } from './error';

export async function exists(fileordir: string) {
	try {
		await fsp.access(fileordir);
		return true;
	} catch (err) {
		return false;
	}
}

export async function mkDir(directory: string) {
	if (!await exists(directory)) {
		await fsp.mkdir(directory);
	}
}

export async function rmDir(directory: string) {
	if (!await exists(directory)) {
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

export async function rmFile(file: string) {
	if (await exists(file)) {
		await fsp.unlink(file);
	}
}

export async function readFileContents(filepath: string) {
	let handle = await fsp.open(filepath, 'r');
	let contents: string;
	try {
		let buf = await handle.readFile();
		contents = buf.toString();
	} catch (err) {
		handle.close();
		throw err;
	}
	handle.close();
	return contents;
}

export async function watchUntil(fileordir: string, cancelEmitter: EventEmitter<void>, donecb: (eventType: string, filename: string|Buffer) => Promise<boolean>){
	return new Promise<void>((resolve, reject) => {
		let watcher = fs.watch(fileordir);
		let cancelEmitterHandle = cancelEmitter.event(_ => {
			watcher.close();
			reject(new CancelError());
		});
		watcher.on('error', err => {
			cancelEmitterHandle.dispose();
			reject(err);
		})
		watcher.on('change', (eventType, fileName) => {
			donecb(eventType, fileName)
				.then(isDone => {
					if (isDone) {
						watcher.close();
						cancelEmitterHandle.dispose();
						resolve();
					}
				})
				.catch(reject);
		});
	});
}

export function removeExtension(file: string) {
	let parts = file.split('.');
	parts.pop();
	return parts.join('.');
}

export function getFileFromPath(filePath: string) {
	let parts = filePath.split('/');
	return parts[parts.length - 1];
}

export function trimStart(subject: string, text: string) {
	if (subject.startsWith(text)) {
		return subject.substring(text.length);
	}
	return subject;
}