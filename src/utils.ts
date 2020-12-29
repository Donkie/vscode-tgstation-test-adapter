import { promises as fsp } from 'fs';
import * as path from 'path';
import * as fs from 'fs';
import * as child from 'child_process';
import { EventEmitter } from 'vscode';
import { CancelError } from './error';

/**
 * Checks if a file or directory exists on the local disk.
 * @param fileordir Path
 */
export async function exists(fileordir: string) {
	try {
		await fsp.access(fileordir);
		return true;
	} catch (err) {
		return false;
	}
}

/**
 * Creates a directory if it doesn't already exist.
 * @param directory Path
 */
export async function mkDir(directory: string) {
	if (!await exists(directory)) {
		await fsp.mkdir(directory);
	}
}

/**
 * Removes a directory and all files inside, if it exists. Does not handle subdirectories.
 * @param directory Path
 */
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

/**
 * Removes a file if it exists.
 * @param file Path
 */
export async function rmFile(file: string) {
	if (await exists(file)) {
		await fsp.unlink(file);
	}
}

/**
 * Reads a files contents into a string.
 * @param filepath Path
 */
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

/**
 * Watches a file or directory for changes. Calls the "donecb" on every change. Returning true in that cb will cause the promise to resolve.
 * @param fileordir Path
 * @param cancelEmitter Emitter which lets you cancel the watch. Throws a CancelError if so.
 * @param donecb Callback where you indicate if you're done watching.
 */
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

/**
 * Spawns a cancelable child process.
 * @param command The process command.
 * @param args The process arguments.
 * @param cancelEmitter An emitter which lets you prematurely cancel and stop the process.
 */
export async function runProcess(command: string, args: string[], cancelEmitter: EventEmitter<void>) {
	return new Promise<string>((resolve, reject) => {
		let stdout = '';
		let process = child.spawn(command, args);
		let cancelListener = cancelEmitter.event(_ => {
			process.kill();
			reject(new CancelError());
		});
		process.stdout.on('data', (data: Buffer) => {
			stdout += data;
		})
		process.stderr.on('data', (data: Buffer) => {
			stdout += data;
		})
		process.once('exit', _ => {
			cancelListener.dispose();
			resolve(stdout);
		})
	});
}

/**
 * Removes the file extension of a file or filepath
 * @param file Path
 */
export function removeExtension(file: string) {
	let parts = file.split('.');
	parts.pop();
	return parts.join('.');
}

/**
 * Returns the file or directory of a path
 * @param filePath Path
 */
export function getFileFromPath(filePath: string) {
	let parts = filePath.split('/');
	return parts[parts.length - 1];
}

/**
 * Trims "text" off the start of "subject" if it starts with it, otherwise returns an unchanged "subject".
 * @param subject The string to trim from
 * @param text The text to match and trim away
 */
export function trimStart(subject: string, text: string) {
	if (subject.startsWith(text)) {
		return subject.substring(text.length);
	}
	return subject;
}